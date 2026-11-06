import { execFile } from 'node:child_process';

export type Runner = (cmd: string, args: string[]) => Promise<string>;

export const run: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`${cmd} ${args.join(' ')}: ${stderr.trim() || err.message}`), { stdout }));
      else resolve(stdout);
    });
  });
