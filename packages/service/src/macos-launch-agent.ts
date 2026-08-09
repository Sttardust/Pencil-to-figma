export interface LaunchAgentOptions {
  label: string;
  repositoryPath: string;
  nodePath: string;
  tsxCliPath: string;
  serviceEntryPath: string;
  stdoutPath: string;
  stderrPath: string;
}

export function renderLaunchAgent(options: LaunchAgentOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(options.nodePath)}</string>
    <string>${xml(options.tsxCliPath)}</string>
    <string>${xml(options.serviceEntryPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(options.repositoryPath)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(options.stderrPath)}</string>
</dict>
</plist>
`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
