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

## Read every response automatically

Next to the speaker button is a waves button that turns on automatic reading for the current thread.
While it is on, each new response is read as soon as it finishes, but only while you are viewing that
thread. If you send a message and move to another thread, the response is prepared in the background
instead, so it is ready the moment you come back and press play. The mode is per thread and lasts
until you reload the app.

## How it works

Before speaking, the response is reshaped by the same agent model that names your threads. Tables
become sentences, code blocks are described instead of recited, and markdown syntax is dropped, so
it sounds like someone talking rather than a document being read. When no model is available, a
simpler fallback strips the markdown instead and reads code blocks as "code sample".

The reformatted text is cached for a week, so a second read never pays the model cost again. Audio
is never cached; it streams from the OpenAI text-to-speech API as it is generated. Each read is
billed by OpenAI. Responses longer than 4,000 characters are read only up to that point, and the
client tells you when that happens. The first read of a response can take a few seconds to start
while the model reformats it.

Read aloud covers the web and desktop clients. It is not available on mobile yet, and it is hidden
on relay connections because those sign each request with a proof this path cannot build.
