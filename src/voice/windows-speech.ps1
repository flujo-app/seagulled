$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -AssemblyName System.Speech
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
  if ($request.action -eq 'capabilities') {
    @{ available = ($voices.Count -gt 0) } | ConvertTo-Json -Compress
    exit 0
  }
  if ($request.action -ne 'speak' -or $request.text -isnot [string] -or $request.text.Length -gt 1200) { throw 'Invalid narration.' }
  $preferred = $voices | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq 'en' } | Select-Object -First 1
  if ($null -ne $preferred) { $synth.SelectVoice($preferred.Name) }
  $stream = New-Object System.IO.MemoryStream
  try {
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $synth.SetOutputToAudioStream($stream, $format)
    $synth.Speak($request.text)
    @{ pcmBase64 = [Convert]::ToBase64String($stream.ToArray()) } | ConvertTo-Json -Compress
  } finally { $stream.Dispose() }
} finally { $synth.Dispose() }
