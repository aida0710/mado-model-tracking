// Turns a file picker selection or a drag-and-drop into files with their path inside the chosen folder.

export interface UploadSource {
  file: File;
  /** Path below the dropped or chosen folder, including the folder name; the bare name for loose files. */
  relativePath: string;
}

/** `webkitdirectory` pickers fill webkitRelativePath; plain pickers leave it empty. */
export function sourcesFromFileList(files: FileList | null): UploadSource[] {
  return Array.from(files ?? [], (file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
}

/** Dropped folders are only reachable through the entry API; DataTransfer.files lists them as empty files. */
export async function sourcesFromDataTransfer(dataTransfer: DataTransfer): Promise<UploadSource[]> {
  const entries = Array.from(dataTransfer.items, (item) => item.webkitGetAsEntry?.() ?? null);
  if (entries.some((entry) => entry === null)) return sourcesFromFileList(dataTransfer.files);
  const nested = await Promise.all(entries.map((entry) => collectEntry(entry as FileSystemEntry, '')));
  return nested.flat();
}

async function collectEntry(entry: FileSystemEntry, parentPath: string): Promise<UploadSource[]> {
  const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (isFileEntry(entry)) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    return [{ file, relativePath }];
  }
  if (!isDirectoryEntry(entry)) return [];
  const children = await readAllEntries(entry.createReader());
  const nested = await Promise.all(children.map((child) => collectEntry(child, relativePath)));
  return nested.flat();
}

/** readEntries returns the directory in batches (about 100 in Chromium) until it returns none. */
async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const entries: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

const isFileEntry = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile;
const isDirectoryEntry = (entry: FileSystemEntry): entry is FileSystemDirectoryEntry => entry.isDirectory;
