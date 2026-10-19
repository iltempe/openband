# Manual check: the Claude Desktop extension (.mcpb)

Run before attaching a `.mcpb` to a release, on **macOS** and on **Windows**. CI already checks that the bundle
builds, validates, and that its server answers `tools/list` with every tool annotated.

1. `npm run build && npm run pack:mcpb` (or download the `openband-mcpb` artifact of the CI run).
2. Double-click `build/openband-<version>.mcpb` (or drag it onto Claude Desktop, or Settings → Extensions → Install).
3. The install dialog shows the OpenBand icon, name, description and the three settings (port 7777, open the studio automatically, samples folder). Install.
4. In a new chat: *“Make a lo-fi beat at 82 BPM in D minor and play it.”*
   - [ ] The studio opens in the default browser by itself on the first tool call.
   - [ ] After one click on *Enter the studio*, the beat is built and plays.
   - [ ] The AI panel in the studio lists the commands.
5. Settings → Extensions → OpenBand → change the port to 7790, restart the chat: the studio opens on `http://127.0.0.1:7790`.
6. Pick a samples folder containing `kick.wav`, ask *“import kick.wav and make a drum kit with it”*: the file is found by name.
7. Turn *open the studio automatically* off: the AI's first call answers that the studio is not open and suggests `open_studio`.
8. Uninstall the extension: nothing is left running (`npx openband doctor` shows the port free).

Note the Claude Desktop version and OS for each run in the release pull request.
