# Read aloud

Read aloud adds a speaker button to the composer that speaks the last assistant response. It is
meant for hands-free listening, like when you are away from the keyboard.

T3 Code only speaks to you. It does not listen, so there is no microphone permission and no
speech-to-text step.

## Set it up

1. Open **Settings** → **Integrations** and find the **Voice** section.
2. Turn on **Read responses aloud**.
3. Enter an OpenAI API key, or set `OPENAI_API_KEY` in the environment that runs the connected T3
   Code server. A key entered in settings is stored only in that client's local settings and
   overrides the server key.
4. Pick a voice. The default is `alloy`.

The speaker button appears in the composer once a key is available and the thread has a finished
response. Select it to read the most recent response, and select it again to stop or cancel.

## How it works

Response text is stripped of markdown before it is spoken, so code blocks and links do not turn
into noise. A code block is read as "code sample".

The voice layer comes from the OpenAI text-to-speech API. Each read is billed by OpenAI. Responses
longer than 4,000 characters are read only up to that point, and the client tells you when that
happens.

Read aloud covers the web and desktop clients. It is not available on mobile yet, and it is hidden
on relay connections because those sign each request with a proof this path cannot build.
