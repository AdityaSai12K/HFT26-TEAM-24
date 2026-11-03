# VisionGuard

An open-source visual assistant for hobby electronics. Point a camera at a breadboard circuit and VisionGuard labels the hardware, traces the wires, checks them against a verified pinout, and sounds an alarm if a wire is about to cause a short.

> **Advisory only.** VisionGuard cannot see everything in a photo. A green result means its automated checks found nothing, not that a circuit is safe. Always check your wiring before applying power.

## Quick start

Developed and tested on Node 26 and Python 3.14, CPU only. The dashboard's sample scenes work without the Python service, so the frontend alone is enough for a first look.

```bash
# Vision service
cd backend
python -m venv .venv
.venv/Scripts/activate        # Windows. On macOS or Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8000
```

The first start downloads about 370 MB of model weights into `backend/weights`. Set `VG_WEIGHTS_DIR` to keep them elsewhere.

```bash
# Dashboard
cd frontend
npm install
cp .env.example .env.local    # Optional: add a Featherless API key
npm run dev                   # http://localhost:3000
```

Without an API key, the assistant answers from the rule engine.

## Using it

1. Upload a straight-down photo, start the live camera, or pick a sample. Samples and **Hazard demo** are rendered scenes with scripted parts, and the dashboard labels them as simulated. The wire tracing and alarm logic on them are real.
2. Read **Traced from this image** to see what was found. If the printed rail lines were readable, wires between the rails are checked straight away, with no alignment.
3. If the board is wrong, correct it in the **Board** dropdown.
4. Press **Align pins** and click the three pins it asks for. Until you do, wires that reach the board stay amber, because VisionGuard does not know which pin they touch.
5. Select a part and use **Mark legs on the image** to tell it which holes the legs are in. If the camera missed a part, use **Add part** and click its two holes. The LED and expected-circuit checks need this on real photos.
6. Colours: green is verified, amber is check it yourself, red is a detected problem.

## How it works

| Stage | Method | Why |
| :--- | :--- | :--- |
| Breadboard | OpenCV hole-lattice fit | A desk is also pale and rectangular. Only a breadboard has the lattice. |
| Rail signs | Red and blue printed lines, measured against the plastic beside them | Needs no clicks, and a colour cast cancels out. Both lines must be found, or the signs stay unknown. |
| Wires | Colour segmentation and skeleton tracing | Boxes cannot show connectivity. Candidates must be thin, smooth and in contrast with their surroundings. Printed rail lines are removed first, so a red wire is not led down a red line. |
| Board ID | CLIP on the whole frame | Named the board correctly in every test photo. |
| Parts | YOLO-World and OpenCV propose, CLIP names | YOLO-World's own labels were mostly wrong on real photos. An empty background class finds far more, so LEDs, resistors, buttons and capacitors only count on the breadboard, where their legs can be checked. |
| Pin map | Three user clicks, checked against board geometry | See below. |
| Rules | TypeScript, on a connectivity graph | Runs in the browser, so the slider and overrides update instantly. |
| Chat | Featherless, grounded and checked | Pin names in a reply are validated against the pinout, and a reply naming an unknown pin is discarded. |

Everything downstream of the vision service is a pure function of the `Scene` it returns. See [frontend/lib/types.ts](frontend/lib/types.ts).

### The rule of unknowns

A rule may only return `pass` when every wire was resolved. Anything the camera could not confirm is `unclear`. "No problem seen" is never reported as "no problem".

The alarm reads the scene before the confidence slider is applied, so a display filter cannot silence it. If the vision service stops during live monitoring, the dashboard says so.

### Why pins are aligned by hand

Automatic placement was built and removed. On real photos it produced fits that passed every check while being rotated 90 degrees, and a wrong map would label a 5V wire as D0. A photo also cannot tell a 38-pin DevKitC from a 30-pin clone, whose aspect ratio is almost identical. Three clicks fix both, and the clicks are rejected if they are mirrored or do not fit the board's shape.

## Rule checks

Power-to-ground short, two supplies tied together, + and - rails joined, power on the wrong rail, LED current limiting, GPIO tied to a rail, wires with unresolved ends, D0/D1 in use (Uno), GPIO6-11 flash pins, 5 V on a GPIO, input-only pins driving a load, and strapping pins (ESP32).

To add one, write a `Rule` in [frontend/lib/rules/engine.ts](frontend/lib/rules/engine.ts). Project templates live in [frontend/data/projects](frontend/data/projects).

## Adding a board

The vision service picks up every profile in [frontend/data/pinouts](frontend/data/pinouts). Add a JSON file with the board's pins, sources and `vision` block (CLIP prompt, PCB colour and detection kind). In the dashboard, add it to `BoardId` in [frontend/lib/types.ts](frontend/lib/types.ts) and to `PINOUTS` in [frontend/lib/pinouts.ts](frontend/lib/pinouts.ts). A new detection kind also needs an entry in [frontend/lib/knowledge.ts](frontend/lib/knowledge.ts).

## Known limitations

- **Part legs are not read from photos.** LEDs and resistors stay `unclear` until you mark their legs.
- **Part detection misses and invents parts.** It can miss resistors or call bare plastic a button, so use **Add part** and the component dropdown to correct it. A photo with no breadboard reports no LEDs, resistors, buttons or capacitors.
- **Rail signs say what a rail is for, not that it is powered.** They come from the printed lines, which blur, fade or are missing on some boards, and mini breadboards have none. Rails with unknown signs are simply not checked this way.
- **Resistor values and LED polarity are not checked.**
- **Black and white wires are not traced.** They have no colour to segment, and a black ground wire is common. An untraced wire is simply invisible to the rules.
- **Blue wires over a teal PCB are lost** at the board edge, so they stay unresolved.
- **Crossing wires of similar colours can merge** into one amber trace.
- **Column numbers are relative** to the visible lattice and may not match the print on the board.
- **Rails are treated as continuous.** Some boards split them halfway, which can cause a false short.
- **In 2D a hovering wire looks plugged in**, so a wire held over a ground column can raise a false alarm.
- **ESP32 pins** need the 38-pin DevKitC layout. Rule checks that need pin positions do not apply to 30-pin clones.
- The live alarm is limited by frame rate, roughly 5-10 fps on a laptop CPU, and it cannot see behind your hand.

## Tests

```bash
cd frontend && npm test       # Rules, hazards, alignment, LLM grounding and fallback
cd backend && pytest          # Pipeline against rendered scenes with known wiring
```

`python -m tools.benchmark [folder]` from `backend/` prints time per image and parts found. Use real photos for detection changes, because the samples are drawings. A higher count is not better by itself, so check the boxes by eye.

`frontend/lib/contract.test.ts` runs scenes written by the real Python pipeline through the real rule engine, which is where the two halves could otherwise drift apart. After changing the pipeline, regenerate them with `python -m tools.make_samples` from `backend/`.

## Sources

Pinouts in [frontend/data/pinouts](frontend/data/pinouts) cite their sources in each file: the Arduino UNO R3 datasheet and PCB-derived drawing, and Espressif's DevKitC user guide, dimensions file and ESP-IDF GPIO reference.
