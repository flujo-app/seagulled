identity.onnx is a Seagulled-authored deterministic CPU fixture: ONNX IR 9,
opset 13, a single Identity node from X to Y, float32 vectors of length two.
It contains no model weights, account data, audio recording or external data.
The native voice runtime regression executes it concurrently through the
actual dependency routes used by recognition and narration.
