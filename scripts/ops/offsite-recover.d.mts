// scripts/ops/offsite-recover.mjs（実行部）から試験で使うものの型。import しても main は動かない（CLI として起動したときだけ動く）。
/** fs.writeSync と同じ形（fd, buffer, offset, length → 書いたバイト数） */
export type SyncWriter = (fd: number, buffer: Buffer, offset: number, length: number) => number;
export function prepareOutDir(dir: string): string;
export function writeAllSync(fd: number, bytes: Uint8Array, writer?: SyncWriter): number;
export function writeFilesAtomically(
  outDir: string,
  files: ReadonlyArray<{ name: string; bytes: Uint8Array }>,
  options?: { writer?: SyncWriter },
): string[];
