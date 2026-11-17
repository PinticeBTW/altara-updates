'use strict';
// Standalone synthetic investigation: no application archive, credentials,
// transport keys, real database, production connection or release-gate edits.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const VERSION = '17.11';
const URL = 'https://get.enterprisedb.com/postgresql/postgresql-17.11-3-windows-x64-binaries.zip';
const ZIP_SHA = '4b8db0930c38f6ef845db919551dedda3b6b845aeb0927b3d79a6e8e9e4537cf';
const check = value => { if (!value) throw new Error('Synthetic probe invariant failed'); };
const fixtureKeys = /^(SystemRoot|SystemDrive|WINDIR|ComSpec|PATH|PATHEXT|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL)$/i;
const runnerKeys = /^(SystemRoot|SystemDrive|WINDIR|ComSpec|PATH|PATHEXT|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|ProgramData|ALLUSERSPROFILE)$/i;
const environment = pattern => Object.fromEntries(Object.entries(process.env).filter(([key]) => pattern.test(key)));
function command(program, args, cwd, env = environment(runnerKeys)) {
  const result = spawnSync(program, args, { cwd, env, encoding: 'utf8', windowsHide: true, shell: false,
    timeout: 120_000, maxBuffer: 1024 * 1024 });
  check(!result.error && !result.signal);
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}
async function digest(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function main() {
  check(process.platform === 'win32' && process.versions.node === '22.18.0');
  check(process.env.GITHUB_REPOSITORY === 'PinticeBTW/altara-updates' && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch');
  check(/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID || '') && path.isAbsolute(process.env.RUNNER_TEMP || ''));
  const root = path.join(process.env.RUNNER_TEMP, `altara-pg-acl-probe-${process.env.GITHUB_RUN_ID}`);
  check(!fs.existsSync(root)); fs.mkdirSync(root);
  const archive = path.join(root, 'postgresql-17.11-3.zip');
  const response = await fetch(URL, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
  check(response.ok && response.body && new globalThis.URL(response.url).protocol === 'https:');
  const fd = fs.openSync(archive, 'wx'); let downloaded = 0;
  try { for await (const chunk of response.body) { downloaded += chunk.length; check(downloaded < 1024 ** 3); fs.writeSync(fd, chunk); } }
  finally { fs.closeSync(fd); }
  check(downloaded > 0 && await digest(archive) === ZIP_SHA);
  const tools = path.join(root, 'postgresql-17.11-3');
  const extractScript = path.join(root, 'expand.ps1');
  fs.writeFileSync(extractScript, '$ErrorActionPreference="Stop"\nExpand-Archive -LiteralPath $args[0] -DestinationPath $args[1]\n');
  const expansion = command('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', extractScript, archive, tools], root);
  check(expansion.status === 0);
  const bin = path.join(tools, 'pgsql', 'bin');
  const binaries = {};
  for (const name of ['postgres', 'initdb', 'pg_ctl', 'psql']) {
    const executable = path.join(bin, `${name}.exe`); check(fs.statSync(executable).isFile());
    binaries[name] = { bytes: fs.statSync(executable).size, sha256: await digest(executable) };
  }
  const postgresVersion = command(path.join(bin, 'postgres.exe'), ['-V'], root);
  check(postgresVersion.status === 0 && postgresVersion.stdout.trim() === `postgres (PostgreSQL) ${VERSION}`);
  const normal = path.join(root, 'normal'), restricted = path.join(root, 'python700'), explicit = path.join(root, 'python700-user-rx');
  fs.mkdirSync(normal);
  const pythonVersion = command('python', ['--version'], root); check(pythonVersion.status === 0);
  const creation = command('python', ['-c', 'from pathlib import Path;import sys\nfor value in sys.argv[1:]:Path(value).mkdir(mode=0o700)', restricted, explicit], root);
  check(creation.status === 0);
  const aclScript = path.join(root, 'acl.ps1');
  fs.writeFileSync(aclScript, String.raw`$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$user = $identity.User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$admin = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$ownerRights = 'S-1-3-4'
$acl = Get-Acl -LiteralPath $args[2]
$originalOwner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
foreach ($sid in @($system, $admin)) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  [void]$acl.AddAccessRule($rule)
}
$readRule = [Security.AccessControl.FileSystemAccessRule]::new($user, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($readRule)
Set-Acl -LiteralPath $args[2] -AclObject $acl
$after = Get-Acl -LiteralPath $args[2]
if ($after.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $originalOwner) { throw 'Probe must preserve the owner' }
$child = Join-Path $args[2] 'inherited-child'
[void][IO.Directory]::CreateDirectory($child)
$paths = @($args[0], $args[1], $args[2], $child)
$rows = foreach ($value in $paths) {
  $current = Get-Acl -LiteralPath $value
  $rules = @($current.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    $sid = $_.IdentityReference.Value
    $principal = if ($sid -eq $user.Value) {'CURRENT_USER'} elseif ($sid -eq 'S-1-5-18') {'SYSTEM'} elseif ($sid -eq 'S-1-5-32-544') {'ADMINISTRATORS'} elseif ($sid -eq 'S-1-3-4') {'OWNER_RIGHTS'} elseif ($sid -eq 'S-1-1-0') {'EVERYONE'} elseif ($sid -eq 'S-1-5-32-545') {'USERS'} else {'OTHER'}
    [pscustomobject]@{ principal=$principal;rights=[string]$_.FileSystemRights;type=[string]$_.AccessControlType;inherited=$_.IsInherited }
  })
  if (($value -eq $args[2]) -or ($value -eq $child)) {
    if (@($rules | Where-Object { $_.principal -notin @('CURRENT_USER','SYSTEM','ADMINISTRATORS') -or $_.type -ne 'Allow' }).Count -ne 0) { throw 'Unexpected private ACL principal' }
    $userRules = @($rules | Where-Object { $_.principal -eq 'CURRENT_USER' })
    if ($userRules.Count -ne 1 -or $userRules[0].rights -match 'Write|FullControl|Modify|Delete') { throw 'Probe must grant no user write permission' }
  }
  [pscustomobject]@{ name=[IO.Path]::GetFileName($value);ownerIsAdministrators=($current.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $admin.Value);ownerIsCurrentUser=($current.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $user.Value);protected=$current.AreAccessRulesProtected;rules=$rules }
}
[pscustomobject]@{ elevated=([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator));directories=@($rows) } | ConvertTo-Json -Depth 8 -Compress
`);
  const acl = command('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', aclScript, normal, restricted, explicit], root);
  check(acl.status === 0);
  const aclReport = JSON.parse(acl.stdout.trim());
  const cases = [];
  for (const [label, cwd] of [['A-normal', normal], ['B-python700', restricted], ['C-explicit-user-rx', explicit]]) {
    for (const [envName, env] of [['fixture', environment(fixtureKeys)], ['safe-runner', environment(runnerKeys)]]) {
      const data = path.join(root, `never-create-cluster-${label}-${envName}`);
      check(!fs.existsSync(data) && !Object.keys(env).some(key => /PG_RESTRICT_EXEC|TOKEN|KEY|SECRET|PASSWORD/i.test(key)));
      const result = command(path.join(bin, 'initdb.exe'), ['--show', '-D', data, '--no-locale', '-U', 'postgres'], cwd, env);
      check(!fs.existsSync(data));
      cases.push({ case: label, environment: envName, status: result.status,
        currentDirectoryInvalid: /The current directory is invalid\./.test(result.stderr), databaseCreated: false,
        stdout: result.stdout.slice(0, 12000), stderr: result.stderr.slice(0, 12000) });
    }
  }
  const a = cases.filter(row => row.case === 'A-normal'), b = cases.filter(row => row.case === 'B-python700'), c = cases.filter(row => row.case === 'C-explicit-user-rx');
  const demonstrated = a.every(row => row.status === 0) && b.every(row => row.status !== 0 && row.currentDirectoryInvalid)
    && c.every(row => row.status === 0);
  console.log(JSON.stringify({ probe: 'synthetic-postgres-windows-acl', version: 1, repository: process.env.GITHUB_REPOSITORY,
    workflowCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, node: process.versions.node,
    python: (pythonVersion.stdout + pythonVersion.stderr).trim(), postgres: postgresVersion.stdout.trim(),
    vendorArchive: { version: '17.11-3', bytes: downloaded, sha256: ZIP_SHA }, binaries,
    acl: aclReport, cases, hypothesisDemonstrated: demonstrated, applicationSourceUsed: false, credentialsUsed: false,
    databasesCreated: 0, releaseGatesChanged: false }, null, 2));
  check(demonstrated);
}
main().catch(() => { console.error('Synthetic directory-access probe failed or its hypothesis was not demonstrated.'); process.exitCode = 1; });
