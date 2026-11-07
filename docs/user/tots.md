# Tots

A Tot is a long-running thread with a name, a face, a job, a voice and a charter, and it moves its work forward without being asked. Making a thread a Tot keeps its history, automations, watches and crew threads. From its next turn the Tot is told its job, voice and charter, and it starts waking on its own.

## Make a Tot

Open a thread's menu, in the sidebar or from its title, and choose **Make this a Tot**. You can also use **Add a Tot** on the Tots page, or search for it in the command palette.

Subagents, side chats and archived threads can't become Tots.

## See your Tots

Open **Tots** from the bottom of the sidebar. Each Tot shows one of four states:

- **Needs you:** it has an open request, its thread is waiting on an approval, an answer or a guest message, it stopped with an error, or it proposed a charter change.
- **Busy:** its thread is running.
- **Idle:** its thread has nothing running.
- **Offline:** T3 Code can't reach the machine it lives on.

A thread's header also shows the Tot connected to it: the thread's own Tot, the Tot that started the work, or the Tot for its project. A Tot and its project have to be on the same machine for the project link to appear.

A Tot's own thread opens as its desk: the details card shows what it's waiting on, its crew, its charter and its wakes, with the usual thread details folded underneath. Wakes where it had nothing to show you fold into one line in the conversation. Open that line to read them.

On your phone, the Threads screen lists everything your Tots are waiting on at the top. Tap one to open the Tot's thread with that request ready to answer. Tap the face button in a Tot's header, or the face above its requests, to see its desk.

## How a Tot acts on its own

Each Tot gets a **Heartbeat**, a schedule that wakes it every hour with a summary of what changed in its project's threads: anything waiting on a request, anything working, and anything new since its last heartbeat. Change or pause it in **Settings → Scheduled tasks**. If you delete it, it comes back paused. A heartbeat is skipped while the Tot is busy, during quiet hours and over the daily limit.

When a Tot has nothing specific to do, it takes the first step that applies:

1. Do what you've approved or its charter allows.
2. Explore the project to find out what's next.
3. Ask you. A Tot's request carries its question, what it found, your options and what's blocked. It stays pinned above the composer in the Tot's thread and under **Needs you** on the Tots page until you answer it or the Tot closes it, however many times the Tot wakes in between. A Tot can have several open, and it carries on with whatever they don't block.

It still asks before anything destructive, public or hard to undo, unless its charter already allows it. To give a Tot more freedom, say so in its charter.

A Tot can also answer approval requests in threads it started, when you or its charter allow it. Anything else stays with you.

## Give a Tot a charter

The charter is what the Tot looks after, the rules it must follow and what matters right now. It's sent on every turn, so it survives compaction, and a long charter uses up the Tot's context faster.

A Tot can't change its own charter. It can propose a new one, and the change appears above the composer in its thread and under **Needs you** on the Tots page, where you can edit it, compare it with the current charter, approve it or dismiss it. Saving your own edit dismisses anything it proposed. Crew threads don't receive the charter.

## Pick a voice

**Full toddler**, **Polite** and **Grown-up** change the words the app uses for that Tot and how it writes to you. Commits, pull requests, code and messages to other threads stay plain.

## Control when it wakes

The **Wakes** tab on a Tot lists its schedules, watches and crew.

- **Quiet hours** and a **Daily wake limit** make scheduled wakes wait. Waiting wakes merge into one turn when they can run, keeping only the latest prompt from each schedule. They use the clock on the machine the Tot lives on.
- A schedule can have a **check**: a command run in the Tot's folder before it wakes. Exit 1 skips the wake. Any other failure still wakes the Tot and tells it the check failed.
- Threads it starts or watches wake it when they finish, fail, ask a question or need approval. The Tot can watch other threads on its machine, and you can stop any of them on this tab. Stopping a thread it started also stops it answering that thread's approvals.
- Your messages, pull request watches, crew results, watched threads and **Run now** always go straight through.

## Choose which models do what

**Crew models** lists roles like "Reviews" with a model for each, and the Tot uses them when it starts crew threads. The Tot can still choose differently if you tell it to. Its own turns, including wakes, use the model set on its thread.

## Change or remove a Tot

Use the pencil on its card, or **Edit Tot** in its thread's menu. Turn off **Use its own name** to have the Tot go by its project's name.

**Turn back into a thread** removes the Tot and leaves the thread as it is. Deleting the thread also removes its Tot.
