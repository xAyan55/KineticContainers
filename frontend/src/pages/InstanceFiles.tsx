import * as React from "react";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  Download,
  File as FileIcon,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  Home,
  Link2,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { ApiError, api, apiBase } from "@/lib/api";
import {
  Button,
  Card,
  EmptyState,
  InlineAlert,
  Input,
  Label,
  StatusBadge,
} from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  children: number | null;
  mode: string;
  mtime: string;
  target: string | null;
}

interface Listing {
  path: string;
  entries: FileEntry[];
  pagination: { limit: number; offset: number; total: number };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function parentPath(p: string): string {
  if (p === "/") return "/";
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

function splitPath(p: string): string[] {
  return p.split("/").filter(Boolean);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    panelRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-black/70" />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="kct-card relative max-h-[85vh] w-full max-w-lg overflow-y-auto p-5 outline-none">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight text-primary">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-primary">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function EntryIcon({ entry }: { entry: FileEntry }): React.JSX.Element {
  if (entry.type === "dir") return <Folder className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />;
  if (entry.type === "symlink") return <Link2 className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />;
  if (/\.(txt|md|conf|cfg|ini|log|json|ya?ml|toml|sh|service|socket|timer|list|sources|cron|env|properties|xml|html?|css|js|ts|py|go|rs|php|rb|pl|lua|sql|csv|tsv)$/i.test(entry.name)) {
    return <FileText className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />;
  }
  return <FileIcon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />;
}

export function FilesTab({ instanceId }: { instanceId: string }): React.JSX.Element {
  // Start in the container administrator's home directory, not the filesystem root.
  const [cwd, setCwd] = React.useState("/root");
  const loadedOnce = React.useRef(false);
  const [listing, setListing] = React.useState<Listing | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | undefined>();
  const [notice, setNotice] = React.useState<string | undefined>();
  const [offset, setOffset] = React.useState(0);
  const [sort, setSort] = React.useState<"name" | "size" | "type" | "mtime">("name");
  const [order, setOrder] = React.useState<"asc" | "desc">("asc");
  const [searchInput, setSearchInput] = React.useState("");
  const [appliedSearch, setAppliedSearch] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const [showCreate, setShowCreate] = React.useState<"file" | "dir" | null>(null);
  const [createName, setCreateName] = React.useState("");
  const [renameTarget, setRenameTarget] = React.useState<FileEntry | null>(null);
  const [renameDest, setRenameDest] = React.useState("");
  const [deleteTargets, setDeleteTargets] = React.useState<FileEntry[] | null>(null);
  const [editorPath, setEditorPath] = React.useState<string | null>(null);
  const [overwriteUpload, setOverwriteUpload] = React.useState<{ dir: string; files: { name: string; content: string }[] } | null>(null);

  const limit = 100;

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({
        path: cwd,
        limit: String(limit),
        offset: String(offset),
        sort,
        order,
      });
      if (appliedSearch) query.set("q", appliedSearch);
      const data = await api.get<Listing>(`/api/instances/${instanceId}/files?${query.toString()}`);
      setListing(data);
      setSelected(new Set());
      setError(undefined);
      loadedOnce.current = true;
    } catch (err) {
      // Containers without a /root home (unusual minimal images) fall back to /.
      if (!loadedOnce.current && cwd === "/root" && err instanceof ApiError && err.code === "NOT_FOUND") {
        setCwd("/");
        return;
      }
      setError(err instanceof ApiError ? err.message : "Unable to list directory.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, cwd, offset, sort, order, appliedSearch]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const navigate = (path: string): void => {
    setCwd(path);
    setOffset(0);
    setAppliedSearch("");
    setSearchInput("");
  };

  const toggleSelect = (path: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const downloadOne = async (path: string): Promise<void> => {
    setBusy(`download:${path}`);
    setError(undefined);
    try {
      const res = await fetch(`${apiBase}/api/instances/${instanceId}/files/download?path=${encodeURIComponent(path)}`, {
        credentials: "include",
      });
      if (!res.ok) {
        let message = "Download failed.";
        try {
          const body = (await res.json()) as { error?: { code?: string; message?: string } };
          message = body.error?.message ?? message;
        } catch {
          // non-JSON error body; keep the generic message
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const name = path.split("/").pop() || "download";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setBusy(null);
    }
  };

  const downloadSelected = async (): Promise<void> => {
    const paths = [...selected];
    setSelected(new Set());
    for (const p of paths) {
      // eslint-disable-next-line no-await-in-loop
      await downloadOne(p);
    }
    setNotice(paths.length > 1 ? `Downloaded ${paths.length} files.` : undefined);
  };

  const readFilesAsUploads = async (files: FileList | File[]): Promise<{ name: string; content: string }[]> => {
    const list = [...files];
    const out: { name: string; content: string }[] = [];
    for (const f of list) {
      // eslint-disable-next-line no-await-in-loop
      const buffer = await f.arrayBuffer();
      out.push({ name: f.name, content: arrayBufferToBase64(buffer) });
    }
    return out;
  };

  const doUpload = async (dir: string, files: { name: string; content: string }[], overwrite: boolean): Promise<void> => {
    setBusy("upload");
    setError(undefined);
    try {
      await api.post(`/api/instances/${instanceId}/files/upload`, { path: dir, files, overwrite });
      setNotice(files.length === 1 ? `Uploaded ${files[0]?.name}.` : `Uploaded ${files.length} files.`);
      setOverwriteUpload(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "ALREADY_EXISTS") {
        const details = err.details as { existing?: string[] } | undefined;
        const existing = details?.existing ?? files.map((f) => f.name);
        setOverwriteUpload({ dir, files });
        setError(`Already exists: ${existing.join(", ")}. Confirm to overwrite.`);
      } else {
        setError(err instanceof ApiError ? err.message : "Upload failed.");
      }
    } finally {
      setBusy(null);
    }
  };

  const handleDropped = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length === 0) return;
    const uploads = await readFilesAsUploads(e.dataTransfer.files);
    await doUpload(cwd, uploads, false);
  };

  const submitCreate = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!showCreate || !createName.trim()) return;
    setBusy("create");
    setError(undefined);
    try {
      const full = joinPath(cwd, createName.trim());
      await api.post(`/api/instances/${instanceId}/files`, { path: full, type: showCreate });
      setShowCreate(null);
      setCreateName("");
      setNotice(`Created ${full}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create entry.");
    } finally {
      setBusy(null);
    }
  };

  const submitRename = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!renameTarget || !renameDest.trim()) return;
    setBusy("rename");
    setError(undefined);
    try {
      await api.patch(`/api/instances/${instanceId}/files/move`, { from: renameTarget.path, to: renameDest.trim() });
      setRenameTarget(null);
      setNotice(`Moved to ${renameDest.trim()}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not move entry.");
    } finally {
      setBusy(null);
    }
  };

  const submitDelete = async (): Promise<void> => {
    if (!deleteTargets || deleteTargets.length === 0) return;
    setBusy("delete");
    setError(undefined);
    try {
      await api.del(`/api/instances/${instanceId}/files`, { paths: deleteTargets.map((t) => t.path) });
      setNotice(deleteTargets.length === 1 ? `Deleted ${deleteTargets[0]?.path}.` : `Deleted ${deleteTargets.length} entries.`);
      setDeleteTargets(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete entries.");
    } finally {
      setBusy(null);
    }
  };

  const entries = listing?.entries ?? [];
  const total = listing?.pagination.total ?? 0;
  const selectedEntries = entries.filter((e) => selected.has(e.path));

  return (
    <div className="flex flex-col gap-4">
      <InlineAlert message={error} />
      {notice ? (
        <div role="status" className="rounded-md border border-highlight bg-raised px-3 py-2 text-sm text-primary">
          {notice}
        </div>
      ) : null}

      <div role="note" className="flex items-start gap-2 rounded-md border border-mid bg-raised px-3 py-2 text-xs text-muted">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          You are browsing the container&apos;s full filesystem. Deleting or editing system files can break this VPS.
          Symlinks are shown but never followed by the backend.
        </span>
      </div>

      <Card
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => void handleDropped(e)}
        className={cn(dragOver && "border-highlight")}
      >
        {/* Breadcrumb */}
        <nav aria-label="Directory" className="mb-3 flex flex-wrap items-center gap-1 text-sm">
          <button
            type="button"
            onClick={() => navigate("/")}
            aria-label="Go to container root"
            className={cn("rounded px-1.5 py-1 hover:bg-raised", cwd === "/" ? "text-primary" : "text-muted hover:text-primary")}
          >
            <Home className="h-4 w-4" aria-hidden="true" />
          </button>
          {splitPath(cwd).map((seg, i, arr) => {
            const full = `/${arr.slice(0, i + 1).join("/")}`;
            const last = i === arr.length - 1;
            return (
              <span key={full} className="flex items-center gap-1">
                <span className="text-muted">/</span>
                {last ? (
                  <span className="px-1 font-medium text-primary" aria-current="page">
                    {seg}
                  </span>
                ) : (
                  <button type="button" onClick={() => navigate(full)} className="rounded px-1 text-muted hover:bg-raised hover:text-primary">
                    {seg}
                  </button>
                )}
              </span>
            );
          })}
          {cwd !== "/" ? (
            <button type="button" onClick={() => navigate(parentPath(cwd))} className="ml-2 inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted hover:bg-raised hover:text-primary">
              <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" /> Up
            </button>
          ) : null}
        </nav>

        {/* Toolbar */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => void load()} aria-label="Refresh directory">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh
          </Button>
          <Button type="button" variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => fileInputRef.current?.click()} disabled={busy !== null}>
            <Upload className="h-3.5 w-3.5" aria-hidden="true" /> Upload
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => {
              const files = e.target.files;
              e.target.value = "";
              if (!files || files.length === 0) return;
              void readFilesAsUploads(files).then((uploads) => doUpload(cwd, uploads, false));
            }}
          />
          <Button type="button" variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => { setCreateName(""); setShowCreate("file"); }}>
            <FilePlus className="h-3.5 w-3.5" aria-hidden="true" /> New file
          </Button>
          <Button type="button" variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => { setCreateName(""); setShowCreate("dir"); }}>
            <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" /> New folder
          </Button>
          {selected.size > 0 ? (
            <>
              <Button type="button" variant="ghost" className="px-3 py-1.5 text-xs" onClick={() => void downloadSelected()}>
                <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download ({selected.size})
              </Button>
              <Button
                type="button"
                variant="danger"
                className="px-3 py-1.5 text-xs"
                onClick={() => setDeleteTargets(selectedEntries)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete ({selected.size})
              </Button>
            </>
          ) : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <form
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                setOffset(0);
                setAppliedSearch(searchInput.trim());
              }}
              className="relative"
            >
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
              <Input aria-label="Search in this directory" className="w-44 py-1.5 pl-8 text-xs" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search names…" />
            </form>
            <select aria-label="Sort by" className="kct-input w-auto py-1.5 text-xs" value={sort} onChange={(e) => { setSort(e.target.value as typeof sort); setOffset(0); }}>
              <option value="name">Name</option>
              <option value="size">Size</option>
              <option value="type">Type</option>
              <option value="mtime">Modified</option>
            </select>
            <select aria-label="Sort direction" className="kct-input w-auto py-1.5 text-xs" value={order} onChange={(e) => setOrder(e.target.value as typeof order)}>
              <option value="asc">Asc</option>
              <option value="desc">Desc</option>
            </select>
          </div>
        </div>
        {dragOver ? <p className="mb-2 text-xs text-primary" role="status">Drop files to upload them into this directory.</p> : null}
        {busy === "upload" ? <p className="mb-2 text-xs text-muted" role="status">Uploading…</p> : null}

        {/* Listing */}
        {loading && !listing ? (
          <p className="py-8 text-center text-sm text-muted" role="status">Loading directory…</p>
        ) : entries.length === 0 ? (
          <EmptyState title="Empty directory" hint={appliedSearch ? "No names match the search in this directory." : "This directory contains no files."} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th scope="col" className="w-8 py-2 pr-2">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={entries.length > 0 && entries.every((e) => selected.has(e.path))}
                      onChange={() => {
                        if (entries.every((e) => selected.has(e.path))) setSelected(new Set());
                        else setSelected(new Set(entries.map((e) => e.path)));
                      }}
                    />
                  </th>
                  <th scope="col" className="py-2 pr-2 font-medium">Name</th>
                  <th scope="col" className="py-2 pr-2 font-medium">Size</th>
                  <th scope="col" className="py-2 pr-2 font-medium">Type</th>
                  <th scope="col" className="py-2 pr-2 font-medium">Permissions</th>
                  <th scope="col" className="py-2 pr-2 font-medium">Modified</th>
                  <th scope="col" className="py-2 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.path} className="border-b border-border/50 text-sm last:border-0 hover:bg-raised/50">
                    <td className="py-2 pr-2">
                      <input type="checkbox" aria-label={`Select ${e.name}`} checked={selected.has(e.path)} onChange={() => toggleSelect(e.path)} />
                    </td>
                    <td className="py-2 pr-2">
                      <span className="flex items-center gap-2">
                        <EntryIcon entry={e} />
                        {e.type === "dir" ? (
                          <button type="button" onClick={() => navigate(e.path)} className="font-medium text-primary hover:underline">
                            {e.name}
                          </button>
                        ) : e.type === "file" ? (
                          <button type="button" onClick={() => setEditorPath(e.path)} className="text-primary hover:underline" title="Open in editor">
                            {e.name}
                          </button>
                        ) : (
                          <span className="text-muted" title={e.target ? `Links to ${e.target}` : e.name}>
                            {e.name}
                            {e.target ? <span className="ml-1 font-mono text-xs">→ {e.target}</span> : null}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="whitespace-nowrap py-2 pr-2 text-xs text-muted">
                      {e.type === "dir" ? (e.children === null ? "—" : `${e.children} item${e.children === 1 ? "" : "s"}`) : formatBytes(e.size)}
                    </td>
                    <td className="py-2 pr-2 text-xs text-muted">{e.type === "dir" ? "Folder" : e.type === "file" ? "File" : e.type === "symlink" ? "Link" : "Special"}</td>
                    <td className="whitespace-nowrap py-2 pr-2 font-mono text-xs text-muted">{e.mode}</td>
                    <td className="whitespace-nowrap py-2 pr-2 text-xs text-muted">{formatDateTime(e.mtime)}</td>
                    <td className="py-2">
                      <div className="flex justify-end gap-1">
                        {e.type === "file" ? (
                          <button type="button" onClick={() => void downloadOne(e.path)} disabled={busy !== null} aria-label={`Download ${e.name}`} title="Download" className="rounded p-1.5 text-muted hover:bg-raised hover:text-primary disabled:opacity-50">
                            <Download className="h-4 w-4" aria-hidden="true" />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => { setRenameTarget(e); setRenameDest(e.path); }}
                          aria-label={`Rename or move ${e.name}`}
                          title="Rename / move"
                          className="rounded p-1.5 text-muted hover:bg-raised hover:text-primary"
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTargets([e])}
                          aria-label={`Delete ${e.name}`}
                          title="Delete"
                          className="rounded p-1.5 text-muted hover:bg-raised hover:text-primary"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > limit ? (
          <div className="mt-3 flex items-center justify-between text-xs text-muted">
            <span aria-live="polite">Showing {offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" className="px-3 py-1 text-xs" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - limit))}>
                Previous
              </Button>
              <Button type="button" variant="ghost" className="px-3 py-1 text-xs" disabled={offset + limit >= total} onClick={() => setOffset((o) => o + limit)}>
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      {showCreate ? (
        <Modal title={showCreate === "file" ? "New file" : "New folder"} onClose={() => setShowCreate(null)}>
          <form onSubmit={(e) => void submitCreate(e)} className="flex flex-col gap-3">
            <div>
              <Label htmlFor="create-name">Name in {cwd}</Label>
              <Input id="create-name" value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder={showCreate === "file" ? "notes.txt" : "backups"} required maxLength={255} disabled={busy !== null} />
              <p className="mt-1 text-xs text-muted">A plain name, no slashes. Missing parent folders are created.</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setShowCreate(null)}>Cancel</Button>
              <Button type="submit" disabled={busy !== null || !createName.trim()}>{busy === "create" ? "Creating…" : "Create"}</Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {renameTarget ? (
        <Modal title={`Rename / move ${renameTarget.name}`} onClose={() => setRenameTarget(null)}>
          <form onSubmit={(e) => void submitRename(e)} className="flex flex-col gap-3">
            <div>
              <Label htmlFor="rename-dest">New container-absolute path</Label>
              <Input id="rename-dest" value={renameDest} onChange={(e) => setRenameDest(e.target.value)} required maxLength={1024} disabled={busy !== null} />
              <p className="mt-1 text-xs text-muted">The destination must not exist yet. Moving across folders is allowed; the container root can never be replaced.</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setRenameTarget(null)}>Cancel</Button>
              <Button type="submit" disabled={busy !== null || !renameDest.trim()}>{busy === "rename" ? "Moving…" : "Move"}</Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {deleteTargets ? (
        <Modal title={deleteTargets.length === 1 ? "Delete entry" : `Delete ${deleteTargets.length} entries`} onClose={() => setDeleteTargets(null)}>
          <p className="text-sm text-muted">
            Permanently delete {deleteTargets.length === 1 ? <span className="font-mono text-primary">{deleteTargets[0]?.path}</span> : `${deleteTargets.length} selected entries`}
            {deleteTargets.some((t) => t.type === "dir") ? " including everything inside deleted folders" : ""}? This cannot be undone.
          </p>
          {deleteTargets.length > 1 ? (
            <ul className="mt-2 max-h-40 overflow-y-auto rounded border border-border p-2 font-mono text-xs text-muted">
              {deleteTargets.map((t) => <li key={t.path}>{t.path}</li>)}
            </ul>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setDeleteTargets(null)}>Cancel</Button>
            <Button type="button" variant="danger" onClick={() => void submitDelete()} disabled={busy !== null}>
              {busy === "delete" ? "Deleting…" : "Delete permanently"}
            </Button>
          </div>
        </Modal>
      ) : null}

      {overwriteUpload ? (
        <Modal title="Overwrite existing files" onClose={() => { setOverwriteUpload(null); setError(undefined); }}>
          <p className="text-sm text-muted">Uploading into <span className="font-mono text-primary">{overwriteUpload.dir}</span> would replace existing files. Overwritten content cannot be recovered.</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => { setOverwriteUpload(null); setError(undefined); }}>Cancel</Button>
            <Button type="button" variant="danger" onClick={() => void doUpload(overwriteUpload.dir, overwriteUpload.files, true)} disabled={busy !== null}>
              {busy === "upload" ? "Uploading…" : "Overwrite"}
            </Button>
          </div>
        </Modal>
      ) : null}

      {editorPath ? (
        <FileEditor
          key={editorPath}
          instanceId={instanceId}
          path={editorPath}
          onClose={() => setEditorPath(null)}
          onSaved={() => { void load(); }}
        />
      ) : null}
    </div>
  );
}

function FileEditor({ instanceId, path, onClose, onSaved }: { instanceId: string; path: string; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const [content, setContent] = React.useState<string | null>(null);
  const [mtime, setMtime] = React.useState<string | null>(null);
  const [size, setSize] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | undefined>();
  const [notice, setNotice] = React.useState<string | undefined>();
  const [saving, setSaving] = React.useState(false);
  const [conflictMtime, setConflictMtime] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<{ path: string; content: string; size: number; mtime: string }>(
        `/api/instances/${instanceId}/files/content?path=${encodeURIComponent(path)}`
      )
      .then((d) => {
        if (cancelled) return;
        setContent(d.content);
        setMtime(d.mtime);
        setSize(d.size);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Unable to open file.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [instanceId, path]);

  const save = async (force: boolean): Promise<void> => {
    if (content === null) return;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await api.put<{ path: string; size: number; mtime: string }>(`/api/instances/${instanceId}/files/content`, {
        path,
        content,
        ...(force ? {} : { expected_mtime: mtime }),
      });
      setMtime(res.mtime);
      setSize(res.size);
      setConflictMtime(null);
      setNotice("Saved.");
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code === "FILE_CHANGED") {
        setConflictMtime(((err.details as { actual_mtime?: string } | undefined)?.actual_mtime) ?? "unknown");
      } else {
        setError(err instanceof ApiError ? err.message : "Could not save.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-black/70" />
      <div role="dialog" aria-modal="true" aria-label={`Edit ${path}`} className="kct-card relative flex max-h-[90vh] w-full max-w-3xl flex-col p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate font-mono text-sm font-semibold text-primary">{path}</h2>
            {!loading && content !== null ? (
              <p className="mt-0.5 text-xs text-muted">{formatBytes(size)} · plain-text editor, no syntax highlighting</p>
            ) : null}
          </div>
          <button type="button" onClick={onClose} aria-label="Close editor" className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-primary">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <InlineAlert message={error} />
        {notice ? (
          <div role="status" className="mb-2 rounded-md border border-highlight bg-raised px-3 py-2 text-sm text-primary">
            {notice}
          </div>
        ) : null}
        {conflictMtime ? (
          <div role="alert" className="mb-2 rounded-md border border-mid bg-raised px-3 py-2 text-sm text-primary">
            This file changed on the container (now {conflictMtime}) after you opened it. Saving now would discard
            those changes. Reload the page, or save anyway to overwrite.
            <div className="mt-2 flex gap-2">
              <Button type="button" variant="ghost" className="px-3 py-1 text-xs" onClick={() => window.location.reload()}>Reload page</Button>
              <Button type="button" variant="danger" className="px-3 py-1 text-xs" onClick={() => void save(true)} disabled={saving}>
                Overwrite anyway
              </Button>
            </div>
          </div>
        ) : null}
        {loading ? (
          <p className="py-10 text-center text-sm text-muted" role="status">Loading file…</p>
        ) : error && content === null ? (
          <EmptyState title="Cannot open file" hint={error} />
        ) : (
          <>
            <textarea
              aria-label={`Edit ${path}`}
              value={content ?? ""}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Tab") {
                  e.preventDefault();
                  const el = e.currentTarget;
                  const start = el.selectionStart;
                  const end = el.selectionEnd;
                  setContent((prev) => `${(prev ?? "").slice(0, start)}  ${(prev ?? "").slice(end)}`);
                  requestAnimationFrame(() => {
                    el.selectionStart = start + 2;
                    el.selectionEnd = start + 2;
                  });
                }
              }}
              spellCheck={false}
              wrap="off"
              className="kct-input min-h-[40vh] flex-1 font-mono text-xs leading-5"
              disabled={saving}
            />
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="text-xs text-muted">
                <StatusBadge status="file" /> Saved atomically; binary files must use download instead.
              </span>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
                <Button type="button" onClick={() => void save(false)} disabled={saving || content === null}>
                  {saving ? "Saving…" : "Save"}
                  {saving ? null : <Check className="h-4 w-4" aria-hidden="true" />}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
