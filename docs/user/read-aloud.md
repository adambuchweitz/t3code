# Read aloud

Read aloud speaks assistant responses so you can listen away from the keyboard. It only speaks:
there is no microphone and no speech-to-text.

Read aloud is available in the web and desktop apps. The mobile app does not have it yet.

## Set it up

1. Open **Settings → Devices** and turn on **Read aloud**.
2. Make sure the T3 server that hosts your threads can reach VoiceStudio on `lan-party` over
   Tailscale. No API key is needed; tailnet membership is the access control.
3. Expand **Read aloud** to pick the default OmniVoice voice or a saved VoiceStudio profile. Select
   **Refresh** after adding or changing profiles in VoiceStudio; T3 Code does not create voices.
4. Adjust speed, language, and the optional gender, age, pitch, accent, and whisper attributes.
   A cloned profile can override attributes that conflict with it. Language guides pronunciation;
   it does not translate the response.

**Preview** speaks the sample text as written. **Advanced voice settings** holds the sampling seed,
generation steps, and guidance strength; more steps take longer. **Reset** returns the profile and
every voice setting to its default.

These preferences belong to the device you set them on. Profiles and previews load through the
environment selected in Settings, and the connection needs permission to operate that environment.

## Listen to a response

When a thread has a finished response, the composer shows a speaker button. Select it to hear the
newest response, and select it again to stop, or to cancel while speech is being prepared.

The waves button next to it reads new responses automatically in that thread. When a turn
completes while it is on, its answer is read as soon as you are viewing the thread. Progress
messages an agent posts while it is still working are not read. Answers that complete
while you are in another thread are prepared in the background, so they start quickly when you come
back and press play. Automatic reading is per thread and turns off when the app reloads.

## What you hear

Before speaking, the thread's server rewrites the response with its text-generation model, the
same one that names threads. Tables become sentences, code is described rather than recited, and
markdown is dropped. If no model answers, simpler cleanup strips the markdown and says "code
sample" for code blocks. Rewritten text is kept for a week, so hearing a response again skips the
model; older copies are deleted when the server starts.

Audio streams from VoiceStudio and is never stored. Responses longer than 4,000 characters are read
up to that point, and T3 Code tells you when it stops early. The first read of a response can take a
few seconds while it is rewritten, and VoiceStudio can take about 25 seconds to load on its first
request.

Speech runs on the T3 server that hosts the thread, so local, remote, and T3 Connect environments
all work, provided that server can reach VoiceStudio. The installed OmniVoice weights are licensed
CC BY-NC; resolve licensing before using this setup for commercial audio.
