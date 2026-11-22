// Rule tables. Everything that decides "this literal or symbol means capability X"
// lives here, so the judgement is reviewable and a fork can extend it without
// touching the pipeline.
//
// Two hard rules learned the expensive way:
//  1. Import matching is by exact name, with one A/W suffix normalisation. Prefix
//     matching filed SendInput as network I/O and SystemParametersInfoA as process spawn.
//  2. A string rule fires on the first match only, and the match is what gets scored:
//     scoring the whole line turns a mention of "license" into a licence check.

export const STRING_RULES = [
  { id: 'network', weight: 3, re: /\bhttps?:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d{1,5})?[^\s"'<>]*/i, label: 'network endpoint' },
  { id: 'ipv4', weight: 2, re: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/, label: 'IP literal' },
  { id: 'domain', weight: 1, re: /(?<![\w.-])(?:[a-z0-9-]{2,63}\.)+(?:com|net|org|cn|io|xyz|top|cc|ru|info|biz|me|app|dev|cloud|site|online)(?![\w-])/i, label: 'domain' },
  { id: 'registry', weight: 2, re: /(?:HKEY_[A-Z_]+|HKLM|HKCU|SOFTWARE\\Microsoft|SOFTWARE\\Classes|CurrentVersion\\Run)/, label: 'registry key' },
  { id: 'persistence', weight: 3, re: /(?:schtasks|CurrentVersion\\Run|LaunchAgents?|LaunchDaemons?|systemd\/system|\/etc\/rc\.local|crontab\s+-|XDG autostart)/i, label: 'autostart mechanism' },
  { id: 'crypto', weight: 2, re: /\b(?:AES|RC4|RSA|ChaCha20|XOR|base64|SHA-?256|HMAC|PBKDF2|bcrypt|argon2)\b/i, label: 'cryptography reference' },
  { id: 'anti-analysis', weight: 3, re: /(?:IsDebuggerPresent|CheckRemoteDebuggerPresent|NtQueryInformationProcess|frida|x64dbg|ollydbg|windbg|vmware|virtualbox|sandbox|qemu|ptrace)/i, label: 'anti-analysis reference' },
  { id: 'privacy-data', weight: 3, re: /(?:Login Data|cookies\.sqlite|wallet\.dat|keychain\.db|Local State|leveldb|WeChat Files|Telegram Desktop|\.ssh\/id_|Keychains\/login)/i, label: 'user data collector' },
  { id: 'licensing', weight: 3, re: /(?:license[ _-]?key|activation[ _-]?(?:code|key|server)|trial[ _-]?(?:period|expired|version)|注册码|激活码|授权码|序列号|hardware[ _-]?id|machine[ _-]?id|hwid|product[ _-]?key)/i, label: 'licensing / activation' },
  { id: 'cli-flags', weight: 1, re: /(?:^|\s)--[a-z][a-z0-9-]{2,24}(?:\s|=|$)/i, label: 'command line switch' },
  { id: 'sql', weight: 2, re: /\b(?:SELECT\s+[\w*,\s]+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|CREATE\s+TABLE|PRAGMA\s+\w+)\b/i, label: 'SQL statement' },
  { id: 'paths', weight: 1, re: /(?:%APPDATA%|%LOCALAPPDATA%|%TEMP%|%PROGRAMDATA%|\/etc\/[a-z]|\/var\/[a-z]|\/Users\/[A-Za-z]|[A-Za-z]:\\+(?:Users|Windows|Program Files|ProgramData)[^"'\s]{2,120})/i, label: 'filesystem path' },
  { id: 'task-scheduler', weight: 3, re: /(?:Task Scheduler|\\Microsoft\\Windows\\|Winlogon|Shell\\Userinit|launchd|systemd\s+\S+\s+enable)/i, label: 'task / logon hook' },
  { id: 'embedded-url-api', weight: 2, re: /\/(?:api|v\d|rest|graphql)\/[a-zA-Z0-9_/?=&.-]{2,80}/, label: 'API route' },
  { id: 'electron', weight: 2, re: /(?:app\.asar|electron|nodeIntegration|contextIsolation|ipcRenderer|BrowserWindow)/i, label: 'Electron surface' },
  { id: 'mobile', weight: 2, re: /(?:AndroidManifest|dalvik|\.dex\b|classes\.dex|ContentProvider|BroadcastReceiver|plist|XCTest|UIKit|SwiftUI)/i, label: 'mobile surface' },
  { id: 'wasm', weight: 2, re: /(?:\.wasm\b|WebAssembly\.instantiate|__wbindgen|__wasm_call_ctors)/i, label: 'WebAssembly surface' },
];

export const API_WEIGHTS = {
  credential: 4, injection: 4, 'anti-debug': 4, service: 3, privilege: 3, hook: 3,
  screen: 2, 'dynamic-load': 3, 'net-http': 3, process: 2, registry: 2, crypto: 2, 'file-io': 1,
};

export const API_SETS = {
  credential: ['CryptUnprotectData', 'LsaEnumerateLogonSessions', 'CredEnumerate', 'CredRead', 'LogonUser', 'WlxQueryConsoleSwitchCredentials', 'CredUIPromptForCredentials'],
  injection: ['VirtualAllocEx', 'WriteProcessMemory', 'ReadProcessMemory', 'CreateRemoteThread', 'CreateRemoteThreadEx', 'NtUnmapViewOfSection', 'SetThreadContext', 'GetThreadContext', 'QueueUserAPC', 'OpenProcess', 'NtCreateThreadEx', 'VirtualProtectEx', 'RtlCreateUserThread', 'NtWriteVirtualMemory', 'NtAllocateVirtualMemory'],
  'anti-debug': ['IsDebuggerPresent', 'CheckRemoteDebuggerPresent', 'NtQueryInformationProcess', 'OutputDebugString', 'GetTickCount', 'GetTickCount64', 'QueryPerformanceCounter', 'NtSetInformationThread', 'NtQuerySystemInformation', 'ptrace'],
  service: ['CreateService', 'OpenSCManager', 'StartService', 'ChangeServiceConfig', 'ControlService', 'DeleteService'],
  privilege: ['AdjustTokenPrivileges', 'OpenProcessToken', 'LookupPrivilegeValue', 'SetTokenInformation', 'ImpersonateLoggedOnUser'],
  hook: ['SetWindowsHookEx', 'GetAsyncKeyState', 'RegisterHotKey', 'GetKeyboardState', 'GetKeyState', 'SetWinEventHook'],
  screen: ['BitBlt', 'GetDC', 'CreateCompatibleBitmap', 'PrintWindow', 'GetWindowDC'],
  'dynamic-load': ['LoadLibrary', 'GetProcAddress', 'LdrLoadDll', 'dlopen', 'dlsym'],
  'net-http': ['WinHttpOpen', 'WinHttpConnect', 'WinHttpSendRequest', 'WinHttpReceiveResponse', 'InternetOpen', 'InternetConnect', 'InternetOpenUrl', 'HttpOpenRequest', 'HttpSendRequest', 'URLDownloadToFile', 'WSASocket', 'WSAStartup', 'socket', 'connect', 'send', 'recv', 'getaddrinfo', 'gethostbyname', 'inet_addr', 'inet_pton', 'WSAConnect', 'WSARecv', 'WSASend', 'DnsQuery'],
  process: ['CreateProcess', 'CreateProcessAsUser', 'ShellExecute', 'ShellExecuteEx', 'WinExec', 'system', 'popen', '_popen', 'fork', 'execve'],
  registry: ['RegOpenKeyEx', 'RegCreateKeyEx', 'RegSetValueEx', 'RegQueryValueEx', 'RegDeleteKey', 'RegDeleteValue', 'RegEnumKeyEx'],
  crypto: ['CryptAcquireContext', 'CryptEncrypt', 'CryptDecrypt', 'CryptGenKey', 'CryptCreateHash', 'CryptHashData', 'BCryptGenRandom', 'BCryptEncrypt', 'BCryptDecrypt', 'BCryptOpenAlgorithmProvider'],
  'file-io': ['CreateFile', 'WriteFile', 'ReadFile', 'CopyFile', 'CopyFileEx', 'MoveFileEx', 'DeleteFile', 'FindFirstFile', 'FindNextFile', 'SetFileAttributes', 'GetTempPath', 'open', 'write', 'unlink'],
};

// The order decides which capability a symbol is filed under when several could claim
// it; the most specific intent wins (credential use is not filed as file I/O).
export const API_ORDER = ['credential', 'injection', 'anti-debug', 'service', 'privilege', 'hook', 'screen', 'dynamic-load', 'net-http', 'process', 'registry', 'crypto', 'file-io'];

export const API_RULES = API_ORDER.map((id) => ({ id, weight: API_WEIGHTS[id] }));

// Windows exports come suffixed with A or W; accept the base name too.
export function apiHit(name, set) {
  if (set.includes(name)) return true;
  if (name.length > 3 && (name.endsWith('A') || name.endsWith('W')) && set.includes(name.slice(0, -1))) return true;
  return false;
}

// Java and Android names carry their intent in the package path, so they get their own
// table instead of being pushed through the Windows one.
export const JAVA_RULES = [
  { id: 'net-http', weight: 3, re: /(?:java\.net\.(?:HttpURLConnection|Socket|URL)|okhttp3|retrofit2|apache\.http)/ },
  { id: 'crypto', weight: 2, re: /(?:javax\.crypto|java\.security\.MessageDigest|javax\.net\.ssl)/ },
  { id: 'file-io', weight: 1, re: /(?:java\.io\.File|java\.nio\.file|java\.io\.FileOutputStream)/ },
  { id: 'credential', weight: 4, re: /(?:android\.accounts|AccountManager|SharedPreferences)/ },
  { id: 'privacy-data', weight: 3, re: /(?:android\.provider\.(?:Contacts|Telephony|CallLog)|getDeviceId|getImei|ContentResolver)/ },
  { id: 'persistence', weight: 3, re: /(?:BOOT_COMPLETED|JobScheduler|AlarmManager|WorkManager)/ },
  { id: 'dynamic-load', weight: 3, re: /(?:DexClassLoader|System\.loadLibrary|Runtime\.getRuntime\(\)\.exec)/ },
  { id: 'screen', weight: 2, re: /(?:MediaProjection|SurfaceControl|createScreenCaptureIntent)/ },
  { id: 'licensing', weight: 3, re: /(?:LVL|LicenseChecker|licen[cs]e|activation)/i },
];

// REA-style capability statements. The `must` line is what a rebuild has to show; it is
// written so that a human can disagree with it in one sentence.
export const CAPABILITIES = {
  'net-http': { statement: 'talks to a remote host over HTTP or raw sockets', must: 'the rebuild performs the same request to the same endpoint', check: 'endpoints' },
  process: { statement: 'spawns or drives child processes', must: 'the rebuild can launch the same external tool with an equivalent argument list', check: 'manual' },
  injection: { statement: 'manipulates another process memory', must: 'the rebuild reproduces the same injection primitive against a local test process', check: 'manual' },
  'anti-debug': { statement: 'detects debuggers or measures timing', must: 'the rebuild exposes a debugger/timing check with the same trigger conditions', check: 'manual' },
  registry: { statement: 'reads or writes registry keys', must: 'the rebuild touches the same key path', check: 'literals' },
  crypto: { statement: 'uses cryptography on payload or config', must: 'the rebuild decrypts or hashes a known sample to the same output bytes', check: 'manual' },
  'file-io': { statement: 'reads and writes files on disk', must: 'the rebuild produces the same files in the same locations', check: 'literals' },
  service: { statement: 'installs or controls a service or daemon', must: 'the rebuild registers an equivalent service entry', check: 'manual' },
  credential: { statement: 'touches stored credentials', must: 'the rebuild reads the same credential source (test fixture only)', check: 'manual' },
  privilege: { statement: 'adjusts process token privileges', must: 'the rebuild enables the same privilege', check: 'manual' },
  hook: { statement: 'captures keyboard or input events', must: 'the rebuild receives the same input events', check: 'manual' },
  screen: { statement: 'captures screen content', must: 'the rebuild produces a comparable screenshot', check: 'manual' },
  persistence: { statement: 'establishes an autostart mechanism', must: 'the rebuild can register the same autostart entry in a sandbox', check: 'literals' },
  'task-scheduler': { statement: 'hooks logon or scheduler triggers', must: 'the rebuild creates the same trigger', check: 'manual' },
  'privacy-data': { statement: 'reads browser, messaging or device user data', must: 'manual: confirm the data sources and the output format', check: 'manual' },
  licensing: { statement: 'checks a licence, activation or hardware binding', must: 'the rebuild rejects and accepts the same inputs as the original', check: 'manual' },
  network: { statement: 'embeds remote endpoints', must: 'every endpoint in the spec is present in the rebuild config', check: 'endpoints' },
  registry_key: { statement: 'uses specific registry paths', must: 'the rebuild references the same paths', check: 'literals' },
  ipv4: { statement: 'uses literal IP addresses', must: 'the rebuild config lists the same addresses', check: 'literals' },
  domain: { statement: 'uses named hosts', must: 'the rebuild config lists the same hosts', check: 'endpoints' },
  sql: { statement: 'issues SQL statements', must: 'the rebuild runs the same schema and queries', check: 'literals' },
  'embedded-url-api': { statement: 'calls documented API routes', must: 'the rebuild exposes the same routes', check: 'endpoints' },
  'dynamic-load': { statement: 'loads code or libraries at run time', must: 'the rebuild loads the same module names', check: 'symbols' },
  electron: { statement: 'is an Electron application', must: 'the rebuild ships the same renderer/main split and preload surface', check: 'manual' },
  mobile: { statement: 'ships as a mobile package', must: 'the rebuild declares the same components and permissions', check: 'manual' },
  wasm: { statement: 'runs WebAssembly', must: 'the rebuild exposes the same imports and exports', check: 'symbols' },
  'hidden-strings': { statement: 'carries strings that were masked to defeat a text scan', must: 'the rebuild keeps those exact values', check: 'endpoints' },
};
