import { spawn } from 'node:child_process';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

function repoName(repoUrl) {
  let u = repoUrl.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const parts = u.split(/[\/:]/).filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return parts[parts.length - 1] || u;
}

export async function cloneRepo(repoUrl, destDir) {
  await run('git', ['clone', '--depth', '1', repoUrl, destDir]);
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: destDir });
  const commit = stdout.trim();
  return { commit, dir: destDir, name: repoName(repoUrl), url: repoUrl };
}

export async function gitDiff(dir, baseRef, headRef = 'HEAD') {
  const { stdout } = await run('git', ['diff', '--name-status', `${baseRef}..${headRef}`], { cwd: dir });
  const out = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(/\t/);
    const raw = parts[0];
    const status = raw[0];
    if (!'AMDR'.includes(status)) continue;
    const path = status === 'R' ? parts[2] : parts[1];
    if (path) out.push({ status, path });
  }
  return out;
}
