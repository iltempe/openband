// The Box as a system service: systemd, launchd or Task Scheduler. The texts are pure, tested in box.test.ts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LABEL = 'it.openband.box';
export const TASK = 'OpenBand Box';

export const systemdUnit = ({ node, bin, data, user = 'openband' }) => `[Unit]
Description=OpenBand Box, the rehearsal recorder
After=network-online.target sound.target
Wants=network-online.target

[Service]
User=${user}
SupplementaryGroups=audio gpio
Environment=OPENBAND_DATA=${data}
ExecStart=${node} ${bin} box
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`;

export const launchdPlist = ({ node, bin, data, log }) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${bin}</string><string>box</string></array>
  <key>EnvironmentVariables</key><dict><key>OPENBAND_DATA</key><string>${data}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;

export function installService({ node = process.execPath, bin, data, platform = process.platform, run = execFileSync }) {
  if (platform === 'linux') {
    fs.writeFileSync('/etc/systemd/system/openband-box.service', systemdUnit({ node, bin, data }));
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['enable', '--now', 'openband-box.service']);
    return 'systemd: openband-box.service';
  }
  if (platform === 'darwin') {
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    fs.writeFileSync(file, launchdPlist({ node, bin, data, log: path.join(data, 'box.log') }));
    run('launchctl', ['load', '-w', file]);
    return `launchd: ${file}`;
  }
  run('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', TASK, '/TR', `"${node}" "${bin}" box`]);
  return `Task Scheduler: ${TASK}`;
}

export function uninstallService({ platform = process.platform, run = execFileSync }) {
  if (platform === 'linux') {
    run('systemctl', ['disable', '--now', 'openband-box.service']);
    fs.rmSync('/etc/systemd/system/openband-box.service', { force: true });
  } else if (platform === 'darwin') {
    const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    run('launchctl', ['unload', '-w', file]);
    fs.rmSync(file, { force: true });
  } else run('schtasks', ['/Delete', '/F', '/TN', TASK]);
}
