// The packed-candidate job consumes the same verified workflow artifact and
// fresh exact-Host runner as the standalone exact-artifact job. Keeping this
// entrypoint preserves the reviewed CI job name without creating a second
// installer or artifact transformation path.
import './spike-exact-artifact-lane.mjs'
