import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  listLocalStories,
  resetLocalStories,
  type LocalStoryMeta,
} from "../lib/localStories";
import { confirmAction, showNotice } from "../lib/dialogs";

/**
 * 同人剧本目录页（`/fanfic`）。
 * 剧本包 = `<资源目录>/assets/library/<packId>/`（含 pack.json + script.txt），
 * 列表数据走 localStories.ts（Rust list_library，回退 read_asset_text）；
 * 导入/删除/打开文件夹走 Rust 命令。所有 Tauri 调用都在事件/副作用里，
 * 且全部 try/catch —— 浏览器里跑 Vite 时页面退化成空态而不报错。
 */

interface LibraryDirInfo {
  library_dir: string;
  pack_count: number;
}

interface InstallResult extends LibraryDirInfo {
  installed: string;
}

interface DeleteResult extends LibraryDirInfo {
  removed: string;
}

/** Tauri 里的 `invoke` 不在时报错文案：`__TAURI_INTERNALS__` 是官方注入标记。 */
const NO_TAURI = "当前不在桌面应用内；请用设置页或命令行安装剧本包。";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function WindowsIcon() {
  return (
    <svg className="fl-win" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M9.5 3.2 3 4.3v7.2h6.5V3.2Zm1.2-.2H21v8.5h-10.3V3ZM9.5 12.5H3v7.2l6.5 1.1v-8.3Zm1.2 0H21v8.5H10.7v-8.5Z"
      />
    </svg>
  );
}

function PackIcon() {
  return (
    <svg className="fl-pack-icon" width="34" height="34" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2 2 2 0 0 1 2-2h4.5A1.5 1.5 0 0 1 20 5.5V18a1.5 1.5 0 0 1-1.5 1.5H14a2 2 0 0 0-2 2 2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 18V5.5Zm1.6.9v11h5.1c.4 0 .8.1 1.3.2V7.1c0-.4-.3-.7-.7-.7H5.6Zm8.3 0c-.4 0-.7.3-.7.7v10.5c.5-.1.9-.2 1.3-.2h5.1v-11h-5.7Z"
      />
    </svg>
  );
}

export default function FanficLibraryPage() {
  const navigate = useNavigate();
  const [library, setLibrary] = useState<LibraryDirInfo | null>(null);
  const [packs, setPacks] = useState<LocalStoryMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const seeded = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    // 重新扫描：清掉 listLocalStories 的缓存，安装/删除后立刻可见。
    resetLocalStories();
    // 必须先要目录：用 --data-root 安装过的包要由 Rust 从磁盘重读，
    // 否则 localStories 的资产目录回退读取会读到旧缓存。
    try {
      if (inTauri()) {
        const dir = await invoke<LibraryDirInfo>("get_library_dir");
        setLibrary(dir);
        // 首次运行（页面挂载时空目录）：播一个示例包，保证不是一片空白。
        if (dir.pack_count === 0 && !seeded.current) {
          seeded.current = true;
          try {
            const s = await invoke<LibraryDirInfo & { seeded: number }>("seed_library");
            setLibrary({ library_dir: s.library_dir, pack_count: s.pack_count });
            resetLocalStories();
          } catch {
            // 命令缺失/失败都无所谓：继续按空目录展示。
          }
        }
      }
    } catch {
      setLibrary(null); // 没有 Tauri（纯 Vite）：只展示空态。
    }
    try {
      setPacks(await listLocalStories());
    } catch (e) {
      setPacks([]);
      setError(`读取剧本包失败：${errText(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const importPacks = useCallback(async () => {
    if (!inTauri()) {
      setError(NO_TAURI);
      return;
    }
    setBusy("import");
    setError("");
    try {
      const picked = await open({
        directory: true,
        multiple: true,
        title: "选择剧本包目录（含 pack.json 与 script.txt）",
      });
      const dirs = (Array.isArray(picked) ? picked : picked ? [picked] : []).filter(
        (p): p is string => typeof p === "string"
      );
      if (dirs.length === 0) return; // 取消
      const done: string[] = [];
      const failed: string[] = [];
      let last: InstallResult | null = null;
      for (const dir of dirs) {
        try {
          last = await invoke<InstallResult>("import_library_pack", { source: dir });
          done.push(last.installed);
        } catch (e) {
          failed.push(`${dir}：${errText(e)}`);
        }
      }
      if (last) setLibrary({ library_dir: last.library_dir, pack_count: last.pack_count });
      await refresh();
      // 逐个安装，允许部分成功：失败项留在页内提示里，同时给一条原生小结。
      setError(failed.length ? `部分剧本包安装失败：${failed.join("；")}` : "");
      if (done.length) {
        await showNotice(
          `已安装 ${done.length} 个剧本包${done.length > 1 ? `（${done.join("、")}）` : ""}。` +
            (failed.length ? `\n${failed.length} 个失败，见页面提示。` : "")
        );
      } else if (failed.length) {
        await showNotice(`安装失败：${failed.join("；")}`);
      }
    } catch (e) {
      setError(`导入失败：${errText(e)}`);
    } finally {
      setBusy("");
    }
  }, [refresh]);

  const openFolder = useCallback(async () => {
    if (!inTauri()) {
      setError(NO_TAURI);
      return;
    }
    setError("");
    try {
      await invoke<string>("open_library_dir");
    } catch (e) {
      setError(`打开文件夹失败：${errText(e)}`);
    }
  }, []);

  const removePack = useCallback(
    async (pack: LocalStoryMeta) => {
      if (!(await confirmAction(`确认删除剧本包「${pack.title || pack.id}」？\n（从资源目录中移除该包目录）`))) {
        return;
      }
      if (!inTauri()) {
        setError(NO_TAURI);
        return;
      }
      setBusy(pack.id);
      setError("");
      try {
        const info = await invoke<DeleteResult>("delete_library_pack", { id: pack.id });
        setLibrary({ library_dir: info.library_dir, pack_count: info.pack_count });
        await refresh();
      } catch (e) {
        // 命令缺失（旧版后端）等错误：直接把消息摆到页内，不吞掉。
        setError(`删除失败：${errText(e)}`);
      } finally {
        setBusy("");
      }
    },
    [refresh]
  );

  const play = (pack: LocalStoryMeta) => navigate(`/play/${encodeURIComponent(pack.id)}`);
  // 编辑器页（/editor/:packId）：与播放同一套 id 编码，页面内再 decodeURIComponent。
  const edit = (pack: LocalStoryMeta) => navigate(`/editor/${encodeURIComponent(pack.id)}`);
  const shownPath = library?.library_dir ?? "";
  const importCmd = shownPath
    ? `node scripts/fanfic/install-library.mjs <包目录> --data-root "${shownPath}"`
    : 'node scripts/fanfic/install-library.mjs <包目录> --data-root "<资源目录>"';

  return (
    <div className="browser-page fanfic-page">
      <div className="browser-header">
        <button className="back-icon" onClick={() => navigate(-1)} aria-label="返回">
          ◀
        </button>
        <h1>同人剧本</h1>
        <span className="fl-spacer" />
        {packs.length > 0 && <span className="fl-count">已安装 {packs.length} 个剧本包</span>}
      </div>

      <div className="browser-content fl-content">
        <div className="fl-toolbar">
          <button className="btn-primary" onClick={importPacks} disabled={busy !== ""}>
            {busy === "import" ? "导入中…" : "导入剧本包…"}
          </button>
          <button className="nav-btn" onClick={openFolder} disabled={busy !== ""}>
            <WindowsIcon />
            打开文件夹
          </button>
          <button className="nav-btn" onClick={() => void refresh()} disabled={busy !== "" || loading}>
            重新扫描
          </button>
          {importCmd && (
            <code className="fl-path">
              {shownPath || "（资源目录未知）"}
              {library ? `（${library.pack_count} 个包）` : ""}
            </code>
          )}
        </div>

        {error && (
          <div className="fl-alert">
            <span>{error}</span>
            <button className="fl-alert-close" onClick={() => setError("")} aria-label="关闭提示">
              ✕
            </button>
          </div>
        )}

        {loading && packs.length === 0 && !error && (
          <div className="fl-empty">
            <p>正在扫描剧本包…</p>
          </div>
        )}

        {!loading && packs.length === 0 && (
          <div className="fl-empty">
            <p className="fl-empty-title">还没有安装同人剧本包</p>
            <p className="fl-empty-text">
              剧本包放在资源目录的 <code>assets/library/&lt;包ID&gt;/</code>，每个包需要
              <code>pack.json</code> 与 <code>script.txt</code>。
              {shownPath ? (
                <>
                  {" "}
                  当前目录：<code>{shownPath}</code>
                </>
              ) : (
                " 在应用「设置 → 资源目录」里可以看到它的路径。"
              )}
            </p>
            <p className="fl-empty-text">也可以复制本地仓库里的示例包，用命令行一键安装：</p>
            <pre className="fl-cmd">
              <code>{importCmd}</code>
            </pre>
            <div className="fl-empty-actions">
              <button className="btn-primary" onClick={importPacks} disabled={busy !== ""}>
                {busy === "import" ? "导入中…" : "导入剧本包…"}
              </button>
              <button className="nav-btn" onClick={openFolder} disabled={busy !== ""}>
                <WindowsIcon />
                打开文件夹
              </button>
            </div>
          </div>
        )}

        {packs.length > 0 && (
          <div className="fl-grid">
            {packs.map((pack) => (
              <div className="fl-card" key={pack.id} data-pack={pack.id}>
                <PackIcon />
                <div className="fl-card-main">
                  <div className="fl-card-title">{pack.title || pack.id}</div>
                  <div className="fl-card-meta">
                    <span className="fl-badge">{pack.chapter || "同人剧场"}</span>
                    {pack.branchPoints.length > 0 && (
                      <span className="fl-badge soft">{pack.branchPoints.length} 个分支点</span>
                    )}
                    <span className="fl-id">{pack.id}</span>
                  </div>
                  <p className="fl-card-desc">{pack.description || "（这个剧本包没有写简介）"}</p>
                </div>
                <div className="fl-card-actions">
                  <button className="btn-primary" onClick={() => play(pack)}>
                    ▶ 播放
                  </button>
                  <button
                    className="nav-btn"
                    onClick={() => edit(pack)}
                    disabled={busy !== ""}
                    title="在应用内编辑这个剧本包"
                  >
                    ✎ 编辑
                  </button>
                  <button
                    className="nav-btn danger"
                    onClick={() => void removePack(pack)}
                    disabled={busy !== ""}
                    title="从资源目录中删除"
                  >
                    {busy === pack.id ? "删除中…" : "删除"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
