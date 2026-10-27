import fs from 'node:fs';
import path from 'node:path';

export class Names {
  private data: Record<string, string> = {};

  constructor(readonly file: string) {
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  all(): Record<string, string> {
    return this.data;
  }

  set(sessionId: string, name: string): void {
    const trimmed = name.trim();
    if (trimmed) this.data[sessionId] = trimmed;
    else delete this.data[sessionId];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
