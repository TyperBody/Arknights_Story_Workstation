import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { isDebugConsoleEnabled, setDebugPref, debugBuildDefault } from "../lib/debugSettings";
import { getPlayerChrome, isHidePlayerBack, setHidePlayerBack, setPlayerChrome, type PlayerChrome } from "../lib/uiSettings";
import { isAndroid } from "../lib/platform";
import { getDownloadSettings, setDownloadSettings } from "../lib/predownload";
import { useDownload } from "../lib/DownloadContext";
import { useCompression } from "../lib/CompressionContext";
import type { Tier, CompressEstimate } from "../lib/CompressionContext";
import type { StoryIndex } from "../hooks/useStoryIndex";
import { collectEnvInfo, copyText } from "../lib/diagnostics";
import { confirmAction } from "../lib/dialogs";
import {
  DEFAULT_SETTINGS,
  DOWNLOAD_CONCURRENCY_MAX,
  DOWNLOAD_CONCURRENCY_MIN,
  MANIFEST_CONCURRENCY_MAX,
  MANIFEST_CONCURRENCY_MIN,
  type MirrorSource,
  setAppSettings,
  useAppSettings,
} from "../lib/appSettings";
import { catalogSummary, mirrorUrl, type CatalogSummary } from "../lib/engineCatalog";

/** 下载源下拉项（`SOURCE_IDS` 的中文标签 + 说明）。 */
const MIRROR_LABELS: Record<MirrorSource, { label: string; hint: string }> = {
  pack: { label: "随包快照 + 官方直连", hint: "优先用安装包内的引擎，缺失时直连 PRTS（默认）" },
  prts: { label: "PRTS 官方直连", hint: "始终从 prts.wiki 官方域名拉取" },
  jsd: { label: "jsDelivr", hint: "cdn.jsdelivr.net，大陆访问通常更快" },
  fastly: { label: "Fastly CDN", hint: "fastly.jsdelivr.net，jsDelivr 的备用线路" },
  ghproxy: { label: "gh-proxy", hint: "经 gh-proxy.com 前缀加速 GitHub 镜像仓" },
  custom: { label: "自定义源", hint: "自填模板 URL；占位符 {url} / {key} / {host} / {path}" },
};

/** 下载源示例 URL（设置页「当前会拼成…」预览。以引擎入口为样例；`example` 处是上游产物哈希）。 */
const SAMPLE_URL = "https://static.prts.wiki/widgets/production/StoryPlayer.example.js";

/** 读设置里的数值：缺/坏/越界 → 默认值（**不抛**）。 */
function clampSetting(value: number, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

interface CacheStatus {
  story_index_cached: boolean;
  asset_db_cached: boolean;
  cached_stories: string[];
  total_size_bytes: number;
}

interface LibraryDirInfo {
  library_dir: string;
  pack_count: number;
}

interface ResourceDirInfo {
  current: string;
  is_custom: boolean;
  default_dir: string;
  fallback_dir: string;
  default_writable: boolean;
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const hideResourceDir = isAndroid();
  const { start: startPredownload, busy: downloadBusy } = useDownload();
  const compression = useCompression();
  const [showCompress, setShowCompress] = useState(false);
  const [compressEst, setCompressEst] = useState<CompressEstimate | null>(null);
  const [selectedTier, setSelectedTier] = useState<Tier | null>(null);
  const [nickname, setNickname] = useState("博士");
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [resDir, setResDir] = useState<ResourceDirInfo | null>(null);
  const [libraryDir, setLibraryDir] = useState<LibraryDirInfo | null>(null);
  const [debugConsole, setDebugConsole] = useState(isDebugConsoleEnabled());
  const [hidePlayerBack, setHidePlayerBackState] = useState(isHidePlayerBack());
  const [playerChrome, setPlayerChromeState] = useState<PlayerChrome>(getPlayerChrome());
  // Download tuning: concurrency + bandwidth limit (shown in KB/s; 0 = unlimited).
  // 并发默认 12（1…32）、manifest 并发默认 10（1…16）—— 均可在 `prts-app-settings` 里改，
  // 未设置时用 `DEFAULT_SETTINGS`；老用户已保存的 Rust 端设置优先（见 useEffect）。
  const appSettings = useAppSettings();
  const [concurrency, setConcurrency] = useState(DEFAULT_SETTINGS.downloadConcurrency);
  const [manifestConcurrency, setManifestConcurrency] = useState(DEFAULT_SETTINGS.manifestConcurrency);
  const [rateLimitKbps, setRateLimitKbps] = useState(0);
  // 「下载器当前真正生效的源」——从 Rust 读回（`download_settings_get`），
  // 用于证明设置页的选择确实推到了下载引擎 / prts-cdn（而不只是 UI 预览）。
  const [rustMirror, setRustMirror] = useState<MirrorSource | null>(null);
  const [envInfo, setEnvInfo] = useState("");
  const [catalog, setCatalog] = useState<CatalogSummary | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("prts-nickname");
    if (saved) setNickname(saved);
    refreshCacheStatus();
    invoke<ResourceDirInfo>("get_resource_dir").then(setResDir).catch(() => {});
    invoke<LibraryDirInfo>("get_library_dir").then(setLibraryDir).catch(() => {});
    getDownloadSettings()
      .then((s) => {
        setConcurrency(s.concurrency);
        setRateLimitKbps(Math.round(s.rateLimitBps / 1024));
        if (s.mirror && s.mirror in MIRROR_LABELS) setRustMirror(s.mirror as MirrorSource);
      })
      .catch(() => {});
    try {
      setCatalog(catalogSummary());
    } catch {
      setCatalog(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 存「下载并发 / 限速」：Rust 端（真正跑下载的）优先，同时写进 appSettings 便于 UI 回显。 */
  const saveDownloadSettings = async (nextConcurrency: number, nextManifest: number, nextKbps: number) => {
    const c = clampSetting(nextConcurrency, DOWNLOAD_CONCURRENCY_MIN, DOWNLOAD_CONCURRENCY_MAX, DEFAULT_SETTINGS.downloadConcurrency);
    const m = clampSetting(nextManifest, MANIFEST_CONCURRENCY_MIN, MANIFEST_CONCURRENCY_MAX, DEFAULT_SETTINGS.manifestConcurrency);
    const kbps = Math.max(0, Math.round(nextKbps) || 0);
    setConcurrency(c);
    setManifestConcurrency(m);
    setRateLimitKbps(kbps);
    setAppSettings({ downloadConcurrency: c, manifestConcurrency: m, rateLimit: kbps * 1024 });
    try {
      await setDownloadSettings({
        concurrency: c,
        rateLimitBps: kbps * 1024,
        mirror: appSettings.mirror,
        customMirror: appSettings.customMirror,
      });
      showMsg(
        `已保存：下载并发 ${c}、清单并发 ${m}，` + (kbps === 0 ? "不限速" : `限速 ${kbps} KB/s`),
      );
    } catch (e) {
      showMsg(`已存到应用设置；同步到下载器失败: ${e instanceof Error ? e.message : String(e)}`, 6000);
    }
  };

  /**
   * 实现里「选中的源**真的生效**」的那一处：写 localStorage（UI 回显）之外，
   * 把 `mirror` / `customMirror` 推给 Rust（`download_settings_set`）。Rust 持
   * 进程级 MirrorSettings，下载引擎的取字节链与 `prts-cdn://` 都即时读它 ——
   * 换源对**已在跑**的下载也生效，无需重启。
   */
  const pushMirrorToRust = useCallback(
    async (mirror: MirrorSource, customMirror: string) => {
      try {
        await setDownloadSettings({
          concurrency,
          rateLimitBps: Math.round(rateLimitKbps) * 1024,
          mirror,
          customMirror,
        });
        setRustMirror(mirror);
      } catch (e) {
        showMsg(`已存到应用设置；同步到下载器失败: ${e instanceof Error ? e.message : String(e)}`, 6000);
      }
    },
    [concurrency, rateLimitKbps],
  );

  /** 选下载源（`mirror` ∈ `SOURCE_IDS`）；`custom` 需配合模板。 */
  const chooseMirror = (next: MirrorSource) => {
    setAppSettings({ mirror: next });
    void pushMirrorToRust(next, appSettings.customMirror);
    showMsg(
      `下载源已切换：${MIRROR_LABELS[next].label}` +
        (next === "custom" && !appSettings.customMirror ? "（记得填模板）" : "（已同步到下载器）"),
    );
  };

  const saveCustomMirror = (next: string) => {
    setAppSettings({ customMirror: next });
    void pushMirrorToRust(appSettings.mirror, next);
  };

  // 「当前源会拼成…」预览：把样例 URL 交给**同一套** mirrorUrl（与下载路径一致）。
  const previewMirror = (source: MirrorSource, template: string): string => {
    try {
      const out = mirrorUrl(source, SAMPLE_URL, template);
      return out ?? "—（该源对本样例不适用 / 缺模板）";
    } catch {
      return "—";
    }
  };

  /** 用系统文件管理器打开 `<资源目录>/assets/library/`。 */
  const openLibraryDir = useCallback(async () => {
    try {
      await invoke<string>("open_library_dir");
    } catch (error) {
      showMsg(`打开失败：${error instanceof Error ? error.message : String(error)}`, 5000);
    }
  }, []);

  /** 选一个剧本包目录，复制进 `<资源目录>/assets/library/<packId>/`。 */
  const importLibraryPack = useCallback(async () => {
    try {
      const picked = await open({ directory: true, multiple: false, title: "选择剧本包目录（含 pack.json 与 script.txt）" });
      if (typeof picked !== "string") return;
      const info = await invoke<LibraryDirInfo & { installed: string }>("import_library_pack", { source: picked });
      setLibraryDir({ library_dir: info.library_dir, pack_count: info.pack_count });
      showMsg(`已安装剧本包「${info.installed}」（共 ${info.pack_count} 个）。返回书架即可看到「同人剧场」。`, 6000);
    } catch (error) {
      showMsg(`安装失败：${error instanceof Error ? error.message : String(error)}`, 6000);
    }
  }, []);

  const chooseResourceDir = async () => {
    try {
      const picked = await open({ directory: true, multiple: false, title: "选择资源目录" });
      if (typeof picked !== "string") return; // cancelled
      const info = await invoke<ResourceDirInfo>("set_resource_dir", { path: picked });
      setResDir(info);
      showMsg("资源目录已更改。已下载的旧资源不会自动迁移，建议重启应用。", 6000);
      refreshCacheStatus();
    } catch (e) {
      showMsg(`更改失败: ${e instanceof Error ? e.message : String(e)}`, 5000);
    }
  };

  const resetResourceDir = async () => {
    try {
      const info = await invoke<ResourceDirInfo>("reset_resource_dir");
      setResDir(info);
      showMsg("已恢复默认资源目录，建议重启应用。", 5000);
      refreshCacheStatus();
    } catch (e) {
      showMsg(`恢复失败: ${e instanceof Error ? e.message : String(e)}`, 5000);
    }
  };

  const togglePlayerBack = () => {
    const next = !hidePlayerBack;
    setHidePlayerBack(next);
    setHidePlayerBackState(next);
    showMsg(next ? "已隐藏播放器内的返回按钮（用系统返回手势）" : "已显示播放器内的返回按钮");
  };

  /** 「播放器底栏」三档：显示 → 自动隐藏 → 隐藏 → 显示。 */
  const cyclePlayerChrome = () => {
    const order: PlayerChrome[] = ["show", "auto", "hide"];
    const next = order[(order.indexOf(playerChrome) + 1) % order.length];
    setPlayerChrome(next);
    setPlayerChromeState(next);
    showMsg(next === "show"
      ? "播放器底栏：显示（默认）"
      : next === "auto"
        ? "播放器底栏：自动隐藏（3 秒无操作后淡出，移动指针恢复）"
        : "播放器底栏：隐藏（可用「文本」面板查看对话）");
  };

  const toggleDebugConsole = () => {
    const next = !debugConsole;
    setDebugPref(next ? "on" : "off");
    setDebugConsole(next);
    showMsg(next ? "已开启调试控制台（左下角「调试日志」）" : "已关闭调试控制台");
  };

  const refreshCacheStatus = useCallback(async () => {
    try {
      const status = await invoke<CacheStatus>("get_cache_status");
      setCacheStatus(status);
    } catch {
      // Ignore
    }
  }, []);

  const copyEnvInfo = async () => {
    try {
      const info = await collectEnvInfo();
      setEnvInfo(info);
      await copyText(info);
      showMsg("环境信息已复制到剪贴板");
    } catch (e) {
      showMsg(`获取失败: ${e instanceof Error ? e.message : String(e)}`, 5000);
    }
  };

  const showMsg = (msg: string, duration = 3000) => {
    setMessage(msg);
    if (duration > 0) setTimeout(() => setMessage(""), duration);
  };

  const saveNickname = () => {
    localStorage.setItem("prts-nickname", nickname);
    showMsg("昵称已保存");
  };

  // Cache the assets of EVERY story in the index (one big background download).
  const cacheAllStories = async () => {
    if (!await confirmAction("将缓存全部剧情的资源，可能占用大量存储与流量，确定开始？")) return;
    setBusy(true);
    showMsg("正在获取剧情目录...", 0);
    try {
      const idx = await invoke<StoryIndex>("fetch_story_index");
      const titles = idx.categories.flatMap((c) =>
        c.chapters.flatMap((ch) => ch.stories.map((s) => s.page_title))
      );
      startPredownload(titles);
      showMsg(`已开始缓存全部 ${titles.length} 个剧情（进度见顶部下载条）`);
    } catch (e) {
      showMsg(`错误: ${e instanceof Error ? e.message : String(e)}`, 5000);
    } finally {
      setBusy(false);
    }
  };

  const clearAllCache = async () => {
    if (!await confirmAction("确认清除所有缓存数据？（会清除热更新引擎与剧情资源；下次联网时自动重建，离线时使用软件内应急副本）")) return;
    try {
      await invoke("clear_cache");
      showMsg("缓存已清除");
      refreshCacheStatus();
    } catch (e) {
      showMsg(`错误: ${e instanceof Error ? e.message : String(e)}`, 5000);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  // Open the compression tier dialog (fetch the size estimate first).
  const openCompress = async () => {
    if (downloadBusy) {
      showMsg("请先完成当前下载，再进行资源压缩。", 4000);
      return;
    }
    setSelectedTier(null);
    setShowCompress(true);
    try {
      setCompressEst(await compression.estimate());
    } catch (e) {
      showMsg(`估算失败: ${e instanceof Error ? e.message : String(e)}`, 5000);
    }
  };

  const confirmCompress = async () => {
    if (!selectedTier) return;
    setShowCompress(false);
    try {
      await compression.start(selectedTier);
      showMsg("已开始压缩资源，进度见底部进度条。");
    } catch (e) {
      showMsg(`压缩失败: ${e instanceof Error ? e.message : String(e)}`, 5000);
    }
  };

  const TIER_LABELS: Record<Tier, string> = {
    off: "关闭",
    lossless: "无损",
    q90: "高质量",
    q70: "极致",
  };

  return (
    <div className="settings-page">
      <div className="settings-content">
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "24px" }}>
        <button className="back-icon" onClick={() => navigate(-1)} aria-label="返回">◀</button>
        <h1 style={{ margin: 0 }}>设置</h1>
      </div>

      {/* Nickname */}
      <div className="setting-group">
        <label>博士昵称（替换剧情中的 &#123;@nickname&#125;）</label>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <input
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="博士"
          />
          <button className="btn-primary" onClick={saveNickname}>保存</button>
        </div>
      </div>

      {/* Download source (mirror) — 换下载源 + 预览 */}
      <div className="setting-group">
        <label>下载源（引擎 / 素材从哪拉）</label>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={appSettings.mirror}
            aria-label="下载源"
            style={{ minWidth: "200px" }}
            onChange={(e) => chooseMirror(e.target.value as MirrorSource)}
          >
            {(Object.keys(MIRROR_LABELS) as MirrorSource[]).map((id) => (
              <option key={id} value={id}>{MIRROR_LABELS[id].label}</option>
            ))}
          </select>
          <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            {MIRROR_LABELS[appSettings.mirror].hint}
          </span>
        </div>
        {appSettings.mirror === "custom" && (
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" }}>
            <input
              type="text"
              value={appSettings.customMirror}
              placeholder="https://your-mirror/{url}（或 …/{host}/{path}）"
              style={{ minWidth: "320px", flex: "1 1 320px" }}
              onChange={(e) => saveCustomMirror(e.target.value)}
            />
            <span style={{ fontSize: "13px", color: "var(--text-secondary)", alignSelf: "center" }}>
              占位符：<code>{`{url}`}</code> 官方直链、<code>{`{key}`}</code> 规范化 key、<code>{`{host}`}</code> / <code>{`{path}`}</code>
            </span>
          </div>
        )}
        <div className="cache-info" style={{ marginTop: "8px", wordBreak: "break-all" }}>
          <div style={{ color: "var(--text-secondary)" }}>
            下载器当前生效源：
            {rustMirror
              ? MIRROR_LABELS[rustMirror].label
              : "读取中…（未连接后端）"}
            {rustMirror && rustMirror !== appSettings.mirror
              ? "（与应用设置不一致，重选一次下载源即可同步）"
              : ""}
          </div>
          <div style={{ color: "var(--text-secondary)" }}>样例预览：{previewMirror(appSettings.mirror, appSettings.customMirror)}</div>
          <div style={{ color: "var(--text-secondary)", marginTop: "4px" }}>
            包内已有的引擎快照会**优先**命中，源只在需要联网补齐时生效；换源即时生效，无需重启。
            {catalog ? `（目录已收录 ${catalog.entries} 条，其中引擎 ${catalog.engine} 条）` : ""}
          </div>
        </div>
      </div>

      {/* Download tuning */}
      <div className="setting-group">
        <label>下载设置（预下载的并发与限速）</label>
        <div style={{ display: "flex", gap: "18px", flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "13px" }}>下载并发</span>
            <input
              type="range"
              min={DOWNLOAD_CONCURRENCY_MIN}
              max={DOWNLOAD_CONCURRENCY_MAX}
              step={1}
              value={concurrency}
              aria-label="下载并发"
              style={{ width: "150px" }}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              onMouseUp={() => saveDownloadSettings(concurrency, manifestConcurrency, rateLimitKbps)}
              onTouchEnd={() => saveDownloadSettings(concurrency, manifestConcurrency, rateLimitKbps)}
              onKeyUp={() => saveDownloadSettings(concurrency, manifestConcurrency, rateLimitKbps)}
            />
            <input
              type="number"
              min={DOWNLOAD_CONCURRENCY_MIN}
              max={DOWNLOAD_CONCURRENCY_MAX}
              value={concurrency}
              aria-label="下载并发数值"
              style={{ width: "64px" }}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              onBlur={() => saveDownloadSettings(concurrency, manifestConcurrency, rateLimitKbps)}
            />
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
              1…{DOWNLOAD_CONCURRENCY_MAX}，默认 {DEFAULT_SETTINGS.downloadConcurrency}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "13px" }}>清单并发</span>
            <input
              type="range"
              min={MANIFEST_CONCURRENCY_MIN}
              max={MANIFEST_CONCURRENCY_MAX}
              step={1}
              value={manifestConcurrency}
              aria-label="清单并发"
              style={{ width: "120px" }}
              onChange={(e) => setManifestConcurrency(Number(e.target.value))}
              onMouseUp={() => saveDownloadSettings(concurrency, manifestConcurrency, rateLimitKbps)}
              onTouchEnd={() => saveDownloadSettings(concurrency, manifestConcurrency, rateLimitKbps)}
              onKeyUp={() => saveDownloadSettings(concurrency, manifestConcurrency, rateLimitKbps)}
            />
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
              1…{MANIFEST_CONCURRENCY_MAX}，默认 {DEFAULT_SETTINGS.manifestConcurrency}（抓剧情资源清单）
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "13px" }}>限速 (KB/s)</span>
            <input
              type="number"
              min={0}
              step={64}
              value={rateLimitKbps}
              style={{ width: "96px" }}
              onChange={(e) => setRateLimitKbps(Number(e.target.value))}
              onBlur={() => saveDownloadSettings(concurrency, manifestConcurrency, rateLimitKbps)}
            />
            <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>0 = 不限速（默认）</span>
          </div>
        </div>
        <div className="cache-info" style={{ marginTop: "8px", color: "var(--text-secondary)" }}>
          并发越高下载越快：大文件并发 {DOWNLOAD_CONCURRENCY_MIN}…{DOWNLOAD_CONCURRENCY_MAX}，小清单并发 {MANIFEST_CONCURRENCY_MIN}…{MANIFEST_CONCURRENCY_MAX}。
          默认下载并发 {DEFAULT_SETTINGS.downloadConcurrency}、清单并发 {DEFAULT_SETTINGS.manifestConcurrency}、不限速；网络不稳时可下调。
        </div>
      </div>

      {/* Hide the reader's on-screen back button */}
      <div className="setting-group">
        <label>播放器返回按钮</label>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <button className="nav-btn" onClick={togglePlayerBack}>
            {hidePlayerBack ? "隐藏播放器返回按钮：开" : "隐藏播放器返回按钮：关"}
          </button>
          <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            {hidePlayerBack ? "阅读时不显示返回按钮，请用系统返回手势" : "阅读时在左上角显示返回按钮"}
          </span>
        </div>
      </div>

      {/* Player bottom bar (engine toolbar) */}
      <div className="setting-group">
        <label>播放器底栏</label>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <button className="nav-btn" onClick={cyclePlayerChrome}>
            {playerChrome === "show" ? "显示" : playerChrome === "auto" ? "自动隐藏" : "隐藏"}
          </button>
          <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            {playerChrome === "show"
              ? "播放时始终显示底部控制条（播放模式 / 播放速度那一行）"
              : playerChrome === "auto"
                ? "3 秒无操作后淡出，移动指针 / 触摸即恢复"
                : "播放时隐藏底部控制条，画面更干净"}
          </span>
        </div>
      </div>

      {/* Debug console */}
      <div className="setting-group">
        <label>调试控制台</label>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <button className="nav-btn" onClick={toggleDebugConsole}>
            {debugConsole ? "调试日志：开" : "调试日志：关"}
          </button>
          <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            {debugConsole
              ? "左下角显示「调试日志」按钮，可查看引擎错误日志"
              : "隐藏左下角的「调试日志」按钮"}
            （构建默认：{debugBuildDefault() ? "开" : "关"}）
          </span>
        </div>
      </div>

      {/* Resource directory (desktop only — Android storage is fixed) */}
      {!hideResourceDir && (
        <div className="setting-group">
        <label>资源目录（剧情图片/音频、引擎文件、缓存的存放位置）</label>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}>
          <button className="btn-primary" onClick={chooseResourceDir}>更改目录…</button>
          {resDir?.is_custom && (
            <button className="nav-btn" onClick={resetResourceDir}>恢复默认</button>
          )}
        </div>
        <div className="cache-info">
          {resDir ? (
            <>
              <div style={{ wordBreak: "break-all" }}>
                当前位置：{resDir.current}
                {resDir.is_custom ? "（自定义）" : "（默认）"}
              </div>
              <div style={{ marginTop: "6px" }}>
                本地剧本包放在 <code>{libraryDir?.library_dir ?? `${resDir.current}\\assets\\library`}</code>
                {libraryDir ? `（已安装 ${libraryDir.pack_count} 个）` : ""}
                <button className="nav-btn" style={{ marginLeft: "6px" }} onClick={openLibraryDir}>打开剧本包文件夹</button>
                {" "}
                <button className="nav-btn" onClick={importLibraryPack}>安装剧本包…</button>
              </div>
              <div style={{ color: "var(--text-secondary)", marginTop: "4px" }}>
                剧本包 = 一个目录，内含 <code>pack.json</code> 与 <code>script.txt</code>；
                也可用 <code>node scripts/fanfic/install-library.mjs</code> 一键安装。
              </div>
              <div style={{ wordBreak: "break-all", color: "var(--text-secondary)" }}>
                默认位置（exe 所在文件夹）：{resDir.default_dir}
                {resDir.default_writable ? "" : " — 不可写，已回退"}
              </div>
              <div style={{ color: "var(--text-secondary)", marginTop: "4px" }}>
                提示：更改目录不会自动迁移已下载的资源；切换后建议重启应用。
                若安装在 Program Files 等无写入权限的位置，会自动回退到系统数据目录。
              </div>
            </>
          ) : (
            <div>正在读取资源目录...</div>
          )}
        </div>
        </div>
      )}

      {/* Cache Management */}
      <div className="setting-group">
        <label>缓存管理</label>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button
            className="btn-primary"
            onClick={cacheAllStories}
            disabled={busy || compression.busy}
          >
            缓存全部剧情
          </button>
          <button
            className="btn-primary"
            onClick={openCompress}
            disabled={busy || compression.busy || downloadBusy}
          >
            压缩资源
          </button>
          <button className="btn-danger" onClick={clearAllCache} disabled={busy || compression.busy}>
            清除所有缓存
          </button>
        </div>
        <div className="cache-info" style={{ marginTop: "12px" }}>
          {cacheStatus ? (
            <>
              <div>已缓存剧情: {cacheStatus.cached_stories.length} 个</div>
              <div>缓存总大小: {formatBytes(cacheStatus.total_size_bytes)}</div>
            </>
          ) : (
            <div>正在读取缓存状态...</div>
          )}
          {compression.tier !== "off" && (
            <div style={{ marginTop: "6px", display: "flex", alignItems: "center", gap: "10px" }}>
              <span>
                实时压缩: 已开启（{TIER_LABELS[compression.tier as Tier] ?? compression.tier}），新下载的图片会自动压缩
              </span>
              {!compression.busy && (
                <button
                  className="nav-btn"
                  style={{ fontSize: "12px" }}
                  onClick={() => compression.disableRealtime()}
                >
                  关闭实时压缩
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Compression tier dialog */}
      {showCompress && (
        <div className="dl-result-overlay" onClick={() => setShowCompress(false)}>
          <div className="dl-result" onClick={(e) => e.stopPropagation()}>
            <div className="dl-result-msg">压缩缓存图片</div>
            <div className="dl-result-sub" style={{ marginBottom: "10px" }}>
              图片转 WebP 可大幅减小占用。选择一个档位后开始；压缩会替换原图，期间无法下载新资源。
              {compression.tier !== "off" && "（已是更高档位的文件不会重复压缩；切到更激进档位会二次重压。）"}
            </div>
            <div className="cache-info" style={{ marginBottom: "10px" }}>
              当前缓存: {compressEst ? formatBytes(compressEst.totalBytes) : "估算中…"}
              {compressEst && `（其中图片 ${formatBytes(compressEst.imageBytes)}）`}
            </div>
            {(["lossless", "q90", "q70"] as Tier[]).map((t) => {
              const est = compressEst
                ? t === "lossless"
                  ? compressEst.losslessBytes
                  : t === "q90"
                    ? compressEst.q90Bytes
                    : compressEst.q70Bytes
                : 0;
              const desc =
                t === "lossless"
                  ? "无损 · 画质完全不变 · 约省 50%"
                  : t === "q90"
                    ? "高质量 · 肉眼无损(SSIM≥0.99) · 约省 79%"
                    : "极致 · 体积最小 · 约省 89%";
              return (
                <label
                  key={t}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "8px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    background: selectedTier === t ? "rgba(244,196,48,0.15)" : "transparent",
                  }}
                >
                  <input
                    type="radio"
                    name="compress-tier"
                    checked={selectedTier === t}
                    onChange={() => setSelectedTier(t)}
                  />
                  <span style={{ flex: "1 1 auto" }}>
                    <div style={{ fontWeight: 600 }}>{TIER_LABELS[t]}</div>
                    <div style={{ fontSize: "12px", opacity: 0.8 }}>{desc}</div>
                  </span>
                  <span style={{ flex: "0 0 auto", textAlign: "right" }}>
                    {compressEst ? `≈ ${formatBytes(est)}` : "—"}
                  </span>
                </label>
              );
            })}
            <div className="dl-result-actions" style={{ marginTop: "10px" }}>
              <button className="btn-primary" onClick={confirmCompress} disabled={!selectedTier}>
                开始压缩
              </button>
              <button className="nav-btn" onClick={() => setShowCompress(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* About */}
      <div className="setting-group">
        <label>关于</label>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={() => navigate("/about")}>
            关于方舟剧场
          </button>
          <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            版本信息、免责声明、开源许可、项目与 PRTS 链接
          </span>
        </div>
      </div>

      {/* Environment / diagnostics */}
      <div className="setting-group">
        <label>环境信息（反馈问题用）</label>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={copyEnvInfo}>
            复制环境信息
          </button>
          <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            含应用/系统/WebView 内核版本，反馈问题时一并提供
          </span>
        </div>
        {envInfo && (
          <pre
            style={{
              marginTop: "10px",
              padding: "10px",
              background: "var(--bg-tertiary)",
              borderRadius: "6px",
              fontSize: "12px",
              lineHeight: "1.5",
              color: "var(--text-secondary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {envInfo}
          </pre>
        )}
      </div>

      {message && (
        <div
          style={{
            padding: "12px",
            background: "var(--bg-tertiary)",
            borderRadius: "4px",
            marginTop: "16px",
            color: message.startsWith("错误") ? "var(--error)" : "var(--success)",
          }}
        >
          {message}
        </div>
      )}
      </div>
    </div>
  );
}
