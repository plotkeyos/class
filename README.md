# Gemara Reading (prototype)

Students read a piece of Gemara, Rashi or Tosfos aloud on an iPad, an AI grades the recording while they take a 2-question quiz, and they see the AI's feedback when they finish. The teacher sets the readings, levels and students, and sees every result.

- **Student page:** the main address (`/`)
- **Teacher page:** `/teacher`

Runs on one Cloudflare Worker. The D1 database (`gemara-reader-db`) and R2 bucket (`gemara-reader-recordings`) already exist in your Cloudflare account and are set in `wrangler.toml`.

## What's in here

| File | What it does |
| --- | --- |
| `src/index.js` | The server: student and teacher API, sign-in, recordings, hourly cleanup |
| `src/grader.js` | The connection to the AI grader. The only file to change when the real grader is ready |
| `public/index.html`, `public/student.js` | The student app |
| `public/teacher.html`, `public/teacher.js` | The teacher backend |
| `public/styles.css`, `public/common.js` | Shared styles and helpers |
| `wrangler.toml` | Cloudflare settings: database, storage, hourly cleanup |

## Set it up

### 1. Put the code on GitHub

1. On github.com, create a new repository (private is fine), for example `gemara-reader`.
2. Click **Add file › Upload files**, drag in everything from this folder (so `wrangler.toml` sits at the top level of the repo), and commit.

### 2. Connect it to Cloudflare

1. In the Cloudflare dashboard, go to **Workers & Pages › Create › Import a repository**.
2. Connect your GitHub account if asked, and choose the repo.
3. Set the project name to **`gemara-reader`** (it must match `name` in `wrangler.toml`).
4. Leave the build command empty. The deploy command should be `npx wrangler deploy`.
5. Click **Deploy**. Every push to GitHub will now deploy automatically.

### 3. Add the teacher access code

1. Open the `gemara-reader` Worker › **Settings › Variables and Secrets › Add**.
2. Type: **Secret**. Name: `TEACHER_CODE`. Value: the code the teacher will sign in with.
3. Save. (Changing it later signs the teacher out everywhere.)

Optional, for testing the whole flow before the real AI exists: add a **Text** variable named `GRADER_URL` with the value `mock`. Students will then see practice feedback instead of "sent to your teacher".

### 4. First sign-in

1. Go to `https://gemara-reader.<your-subdomain>.workers.dev/teacher` (Cloudflare shows the exact address after deploying) and sign in.
2. **Settings:** set the class code. The school time zone is filled in from your device; check it's right.
3. **Levels:** add your levels.
4. **Students:** paste the class list, one name per line, and set each student's level.
5. **Readings:** paste the day's material, then each level's piece and its 2 questions. Mark the correct answer. Save.

### 5. Set up each iPad

1. Open the main address in **Safari**.
2. Optional: **Share › Add to Home Screen** so it opens full screen. If you do, use the Home Screen icon from then on (it keeps its own sign-in).
3. Type the class code once.
4. Allow the microphone. To stop Safari asking every time: **Settings › Apps › Safari › Microphone › Allow** (on older iPadOS, **Settings › Safari**).

## Daily use

- **Teacher:** set the readings on the Readings tab (you can prepare days ahead with the date picker). Watch the Today tab during class. Use **Allow another try** if a student needs to redo it.
- **Students:** tap their name, read, send, answer the 2 questions, see feedback, tap Done.
- Anything the AI couldn't grade shows up under **Manual grading**. Those grades are for the teacher only.
- **Reports:** choose dates and students, then download a spreadsheet (.xlsx) or PDF. The PDF opens the print window; choose **Save as PDF** (on iPad, **Share › Save to Files**).

Recordings are deleted automatically after 7 days. Scores and feedback are kept.

## Connecting the real AI grader

Set `GRADER_URL` (Text variable) to the grader's address, and `GRADER_KEY` (Secret) if it needs a key. The Worker sends each recording as `multipart/form-data`:

| Field | Contents |
| --- | --- |
| `audio` | The recording (`audio/mp4` from iPads) |
| `text` | The exact text the student was supposed to read |
| `source_type` | `gemara`, `rashi` or `tosfos` |
| `attempt_id` | An id for logging |

with `Authorization: Bearer <GRADER_KEY>` if a key is set. It expects JSON back:

```json
{ "feedback": "Full feedback shown to the student", "score": 87 }
```

`score` is optional. If the grader works differently, only `src/grader.js` needs to change.

If the grader fails or takes longer than `GRADER_TIMEOUT_SECONDS` (default 120), the reading goes to Manual grading. Grading runs while the student's iPad is on the quiz or feedback screen. If the real grader regularly takes more than about 30 seconds, it should move to a Cloudflare Queue so it doesn't depend on that.

## Testing on a computer

```bash
npm install
cp .dev.vars.example .dev.vars
npx wrangler dev
```

Open `http://localhost:8787` and `http://localhost:8787/teacher` (access code `test-teacher`). This uses a local copy of the database and storage, not the real ones.
