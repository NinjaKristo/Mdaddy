# Mdaddy working rule

- Treat `release/Mdaddy.exe` as the app under test and keep it updated from the current source for every UI delivery/checkpoint.
- Run `bash scripts/build-release.sh` after UI changes. It regenerates app icons from `Assets/MdaddyIcon-App.svg`, builds the frontend and executable, copies the release binary, checks that it matches the build output, and runs the isolated release smoke and UI-controls E2E tests.
- Never let the tests silently forward to an already-running single instance. If Mdaddy is open, leave it alone and report the release test as blocked until the app is closed normally.
- Do not call a UI change complete based only on a frontend or Cargo build; verify the release executable and its visible controls.
