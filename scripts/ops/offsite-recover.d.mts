// scripts/ops/offsite-recover.mjs（実行部）から試験で使うものの型。import しても main は動かない（CLI として起動したときだけ動く）。
export function prepareOutDir(dir: string): string;
export function writeFilesAtomically(outDir: string, files: ReadonlyArray<{ name: string; bytes: Uint8Array }>): string[];
