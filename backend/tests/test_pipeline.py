"""Ground-truth tests: render a bench with known wiring, then check what comes back."""
from types import SimpleNamespace

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import breadboard as bb, main
from app.boards import BOARD_IDS, PinMap, load_pinout, pcb_region
from app.geometry import project
from app.pipeline import MAX_PROPOSALS, Options, _parts, analyze
from app.scene_render import PITCH, SCENARIOS, Scenario, node_xy, render, uno_quad
from app.wires import _rail_strips, ribbons
from app.zeroshot import YOLO_BACKGROUND, YOLO_PROMPTS, Models, pick_device

BY_NAME = {s.name: s for s in SCENARIOS}


@pytest.fixture(scope="module")
def models():
    return Models()  # Unloaded on purpose: the OpenCV stages must work without any model.


def rail_strips_for(image):
    return _rail_strips(image, bb.locate(image))


def run(scenario: Scenario, models, **options):
    image, _ = render(scenario)
    return analyze(image, models, Options(board="arduino_uno", quad=uno_quad().tolist(), **options))


class TestBreadboard:
    def test_finds_the_lattice(self):
        image, _ = render(BY_NAME["blink-ok"])
        fit = bb.locate(image)
        assert fit is not None
        assert fit.columns == 30
        assert fit.pitch_px() == pytest.approx(PITCH, rel=0.05)

    def test_rejects_a_blank_pale_surface(self):
        assert bb.locate(np.full((800, 1200, 3), 235, np.uint8)) is None

    def test_rejects_a_plain_desk_with_noise(self):
        grain = np.random.default_rng(1).normal(170, 8, (800, 1200, 3))
        assert bb.locate(np.clip(grain, 0, 255).astype(np.uint8)) is None

    @pytest.mark.parametrize("angle", [-25, 12, 35])
    def test_keeps_rows_straight_when_rotated(self, angle):
        image, _ = render(BY_NAME["blink-ok"])
        center = (image.shape[1] / 2, image.shape[0] / 2)
        matrix = cv2.getRotationMatrix2D(center, angle, 0.8)
        rotated = cv2.warpAffine(image, matrix, (image.shape[1], image.shape[0]), borderValue=(150, 175, 195))
        fit = bb.locate(rotated)
        assert fit is not None
        # Column 8 and column 9 must stay distinct nodes after rotation.
        a = cv2.transform(np.array([[node_xy("bb:8:top")]], dtype=np.float64), matrix)[0, 0]
        b = cv2.transform(np.array([[node_xy("bb:9:top")]], dtype=np.float64), matrix)[0, 0]
        assert bb.nearest_node(fit, a)[0] != bb.nearest_node(fit, b)[0]


class TestRailSigns:
    EXPECTED = {"top": {"inner": "-", "outer": "+"}, "bottom": {"inner": "+", "outer": "-"}}

    def test_reads_signs_from_the_printed_lines(self):
        image, _ = render(BY_NAME["blink-ok"])
        assert bb.read_rail_polarity(image, bb.locate(image)) == self.EXPECTED

    def test_a_cold_white_balance_does_not_flip_or_lose_them(self):
        image, _ = render(BY_NAME["blink-ok"])
        cast = np.clip(image.astype(np.float64) * [1.25, 1.0, 0.8], 0, 255).astype(np.uint8)
        assert bb.read_rail_polarity(cast, bb.locate(cast)) == self.EXPECTED

    def test_upside_down_swaps_the_sides_with_the_board(self):
        image, _ = render(BY_NAME["blink-ok"])
        turned = cv2.rotate(image, cv2.ROTATE_180)
        polarity = bb.read_rail_polarity(turned, bb.locate(turned))
        assert polarity == {"top": self.EXPECTED["bottom"], "bottom": self.EXPECTED["top"]}

    def test_a_board_with_no_lines_stays_unknown(self):
        image, _ = render(BY_NAME["blink-ok"])
        grey = cv2.cvtColor(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
        fit = bb.locate(grey)
        assert bb.rail_marks(grey, fit, 1.0) == []

    def test_one_missing_line_leaves_that_pair_unknown(self):
        image, _ = render(BY_NAME["blink-ok"])
        fit = bb.locate(image)
        scrubbed = image.copy()
        ends = project(fit.to_image, np.array([[-fit.half_length, -fit.rails["top"]["outer"] - 0.8], [fit.half_length, -fit.rails["top"]["outer"] - 0.8]]))
        cv2.line(scrubbed, tuple(ends[0].astype(int).tolist()), tuple(ends[1].astype(int).tolist()), (235, 238, 240), 12)
        polarity = bb.read_rail_polarity(scrubbed, fit)
        assert polarity["top"] == {"inner": None, "outer": None}
        assert polarity["bottom"] == self.EXPECTED["bottom"]

    def test_a_wire_across_the_rails_resolves_with_no_pin_alignment(self, models):
        image, _ = render(BY_NAME["rails-joined"])
        scene = analyze(image, models, Options(board="arduino_uno"))
        signs = {mark["node"]: mark["sign"] for mark in scene["breadboard"]["railMarks"]}
        ends = [end["node"] for end in scene["wires"][0]["ends"]]
        assert sorted(signs[node] for node in ends) == ["+", "-"]

    def test_a_red_wire_is_not_led_down_the_red_line_it_crosses(self):
        image, _ = render(BY_NAME["rails-joined"])
        fit = bb.locate(image)
        red = next(r for r in ribbons(image, fit.pitch_px(), None, fit) if r.colour == "red")
        ends = sorted(map(tuple, (red.path[0], red.path[-1])), key=lambda p: p[1])
        assert ends[0] == pytest.approx(node_xy("rail:top-outer"), abs=PITCH)
        assert ends[1] == pytest.approx(node_xy("rail:bottom-outer"), abs=PITCH)

    def test_without_rail_lines_the_strips_are_left_alone(self):
        image, _ = render(BY_NAME["blink-ok"])
        grey = cv2.cvtColor(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
        assert not rail_strips_for(grey).any()

    def test_marks_are_in_original_image_pixels(self, models):
        image, _ = render(BY_NAME["blink-ok"])
        big = cv2.resize(image, None, fx=2, fy=2)
        scene = analyze(big, models, Options(board="arduino_uno"))
        fit = bb.locate(image)
        small = {m["node"]: m["from"] for m in bb.rail_marks(image, fit, 1.0)}
        for mark in scene["breadboard"]["railMarks"]:
            assert mark["from"] == pytest.approx([v * 2 for v in small[mark["node"]]], abs=8)


class TestWires:
    def test_ignores_printed_rail_lines(self):
        image, _ = render(Scenario("empty", "", wires=[]))
        fit = bb.locate(image)
        assert ribbons(image, fit.pitch_px(), pcb_region("arduino_uno", image, fit.quad), fit) == []

    def test_empty_bench_reports_no_wires(self, models):
        assert run(Scenario("empty", "", wires=[]), models)["wires"] == []

    def test_no_wire_is_invented_for_a_bare_desk(self, models):
        grain = np.random.default_rng(2).normal(170, 8, (800, 1200, 3))
        scene = analyze(np.clip(grain, 0, 255).astype(np.uint8), models, Options(board="arduino_uno"))
        assert scene["wires"] == []

    def test_each_end_lands_on_the_right_pin(self, models):
        scene = run(BY_NAME["blink-ok"], models)
        nodes = {wire["color"]: {end["node"] for end in wire["ends"]} for wire in scene["wires"]}
        assert "pin:D13" in nodes["yellow"]
        assert "pin:GND3" in nodes["green"]

    def test_power_short_is_traced_end_to_end(self, models):
        scene = run(BY_NAME["short"], models)
        nodes = {wire["color"]: {end["node"] for end in wire["ends"]} for wire in scene["wires"]}
        assert "pin:5V" in nodes["red"]
        assert "pin:GND1" in nodes["orange"]
        # The third wire must join the same rail and column, or the short is not closed.
        rail = next(n for n in nodes["red"] if n != "pin:5V")
        column = next(n for n in nodes["orange"] if n != "pin:GND1")
        assert nodes["purple"] == {rail, column}

    def test_blue_over_the_teal_pcb_stays_unresolved_rather_than_guessed(self, models):
        scene = run(Scenario("blue", "", wires=[("blue", "pin:D2", "bb:12:top")]), models)
        ends = {e["node"] for w in scene["wires"] for e in w["ends"]}
        assert "pin:D2" not in ends

    def test_column_numbers_distinguish_neighbours(self, models):
        scene = run(BY_NAME["blink-ok"], models)
        columns = {wire["color"]: next(e["node"] for e in wire["ends"] if e["node"] and e["node"].startswith("bb:")) for wire in scene["wires"]}
        offset = int(columns["green"].split(":")[1]) - int(columns["yellow"].split(":")[1])
        assert offset == 6

    def distance_to(self, scene, target: str) -> float:
        red = next(w for w in scene["wires"] if w["color"] == "red")
        loose = next(e for e in red["ends"] if e["node"] != "pin:5V")
        return dict(loose["nearby"])[target]

    def test_a_hovering_end_reports_what_it_is_near(self, models):
        scene = run(BY_NAME["approach-far"], models)
        target = next(e["node"] for w in scene["wires"] if w["color"] == "green" for e in w["ends"] if e["node"] != "pin:GND1")
        assert self.distance_to(scene, target) == pytest.approx(2.6, abs=0.7)

    def test_distance_to_the_target_shrinks_as_the_wire_closes(self, models):
        far, near = run(BY_NAME["approach-far"], models), run(BY_NAME["approach-near"], models)
        target = next(e["node"] for w in far["wires"] if w["color"] == "green" for e in w["ends"] if e["node"] != "pin:GND1")
        assert self.distance_to(near, target) < self.distance_to(far, target) - 1

    def test_unaligned_board_leaves_the_pin_end_unresolved(self, models):
        image, _ = render(BY_NAME["blink-ok"])
        scene = analyze(image, models, Options(board="arduino_uno"))
        assert scene["wires"], "wires reach the breadboard, so they still count"
        for wire in scene["wires"]:
            assert not any((e["node"] or "").startswith("pin:") for e in wire["ends"])
        assert any("Align" in w for w in scene["warnings"])


class TestBoardProfiles:
    def test_every_pinout_file_is_a_board(self):
        assert set(BOARD_IDS) == {"arduino_uno", "esp32_devkitc"}

    @pytest.mark.parametrize("board_id", BOARD_IDS)
    def test_a_profile_has_what_the_vision_stages_need(self, board_id):
        vision = load_pinout(board_id)["vision"]
        assert load_pinout(board_id)["id"] == board_id
        assert vision["kind"] and vision["clipPrompt"] and vision["pcb"]["type"] in ("colour", "dark")


class TestPinMap:
    def test_uno_pins_are_placed_from_the_alignment(self):
        pins = PinMap(load_pinout("arduino_uno"), uno_quad())
        for pin in ("D13", "5V", "A0", "SCL"):
            node, distance = pins.nearest(node_xy(f"pin:{pin}"))
            assert node == f"pin:{pin}"
            assert distance < 0.01


class TestScene:
    def test_teal_pcb_is_called_an_uno_when_no_model_answers(self, models):
        image, _ = render(BY_NAME["blink-ok"])
        scene = analyze(image, models)
        assert scene["board"]["id"] == "arduino_uno"
        assert scene["board"]["confidence"] == 0.5
        kinds = [d["kind"] for d in scene["detections"]]
        assert "arduino_uno" in kinds and "esp32" not in kinds

    def test_no_board_means_no_board(self, models):
        scene = analyze(np.full((800, 1200, 3), 235, np.uint8), models)
        assert scene["board"]["id"] is None
        assert scene["detections"] == []

    def test_breadboard_transform_is_in_original_image_pixels(self, models):
        image, _ = render(BY_NAME["blink-ok"])
        big = cv2.resize(image, None, fx=2, fy=2)
        scene = analyze(big, models, Options(board="arduino_uno"))
        matrix = np.array(scene["breadboard"]["toBoard"])
        x, y = node_xy("bb:8:top")
        point = matrix @ np.array([x * 2, y * 2, 1.0])
        board = point[:2] / point[2]
        assert abs(board[1]) < 6

    def test_reports_coordinates_in_the_original_image(self, models):
        image, _ = render(BY_NAME["blink-ok"])
        big = cv2.resize(image, None, fx=2, fy=2)
        scene = analyze(big, models, Options(board="arduino_uno", quad=(uno_quad() * 2).tolist()))
        assert scene["imageSize"] == [2560, 1800]
        yellow = next(w for w in scene["wires"] if w["color"] == "yellow")
        target = np.array(node_xy("pin:D13")) * 2
        assert min(np.linalg.norm(np.array(e["point"]) - target) for e in yellow["ends"]) < PITCH * 2


class TestProposals:
    def fake_yolo(self, calls):
        def predict(image, **options):
            calls.append(options)
            boxes = SimpleNamespace(xyxy=np.array([[1.0, 2.0, 3.0, 4.0]]), conf=np.array([0.5]))
            return [SimpleNamespace(boxes=boxes)]

        return SimpleNamespace(predict=predict)

    def test_background_boxes_never_become_proposals(self):
        calls = []
        models = Models()
        models.yolo = self.fake_yolo(calls)
        assert models.propose(np.zeros((10, 10, 3), np.uint8)) == [(1.0, 2.0, 3.0, 4.0, 0.5)]
        assert calls[0]["classes"] == list(range(len(YOLO_PROMPTS)))
        assert YOLO_BACKGROUND not in YOLO_PROMPTS

    def test_a_confident_large_box_is_not_cut_for_small_weak_ones(self):
        tiny = [(float(x), 0.0, x + 20.0, 20.0, 0.05) for x in range(0, 40 * (MAX_PROPOSALS + 2), 40)]
        strong = (100.0, 200.0, 200.0, 300.0, 0.9)
        models = SimpleNamespace(label_crops=lambda crops: [("pin_header", 0.9)] * len(crops))
        blank = np.zeros((800, 1200), np.uint8)
        found = _parts(np.zeros((800, 1200, 3), np.uint8), [*tiny, strong], models, blank, 1.0, None)
        assert len(found) == MAX_PROPOSALS
        assert [100.0, 200.0, 200.0, 300.0] in [d["box"] for d in found]

    def test_breadboard_blobs_outrank_scored_boxes(self):
        scored = [(float(x), 0.0, x + 20.0, 20.0, 0.9) for x in range(0, 40 * MAX_PROPOSALS, 40)]
        blob = (100.0, 200.0, 200.0, 300.0, 0.0)
        models = SimpleNamespace(label_crops=lambda crops: [("pin_header", 0.9)] * len(crops))
        blank = np.zeros((800, 1200), np.uint8)
        found = _parts(np.zeros((800, 1200, 3), np.uint8), [*scored, blob], models, blank, 1.0, None)
        assert [100.0, 200.0, 200.0, 300.0] in [d["box"] for d in found]


    def breadboard_parts(self, kind, fit):
        image, _ = render(BY_NAME["blink-ok"])
        x, y = node_xy("bb:8:top")
        on_board = (x - 20, y - 20, x + 20, y + 20, 0.5)
        on_desk = (20.0, 20.0, 60.0, 60.0, 0.5)
        models = SimpleNamespace(label_crops=lambda crops: [(kind, 0.9)] * len(crops))
        blank = np.zeros(image.shape[:2], np.uint8)
        return [d["box"][0] for d in _parts(image, [on_board, on_desk], models, blank, 1.0, fit)]

    @pytest.mark.parametrize("kind", ["led", "resistor", "capacitor", "button"])
    def test_a_part_off_the_breadboard_is_dropped(self, kind):
        image, _ = render(BY_NAME["blink-ok"])
        assert self.breadboard_parts(kind, bb.locate(image)) == [node_xy("bb:8:top")[0] - 20]

    def test_no_breadboard_means_no_breadboard_parts(self):
        assert self.breadboard_parts("led", None) == []

    def test_board_parts_are_kept_anywhere(self):
        image, _ = render(BY_NAME["blink-ok"])
        assert len(self.breadboard_parts("pin_header", bb.locate(image))) == 2


class TestDevice:
    @pytest.mark.parametrize(("cuda", "mps", "expected"), [(True, True, "cuda"), (False, True, "mps"), (False, False, "cpu")])
    def test_picks_the_fastest_device_available(self, monkeypatch, cuda, mps, expected):
        torch = pytest.importorskip("torch")
        monkeypatch.setattr(torch.cuda, "is_available", lambda: cuda)
        monkeypatch.setattr(torch.backends.mps, "is_available", lambda: mps)
        assert pick_device() == expected


class TestApi:
    @pytest.fixture
    def client(self):
        return TestClient(main.app)

    def test_health_reports_the_device(self, client):
        assert client.get("/health").json()["device"] == main.models.device

    def encode(self):
        image, _ = render(BY_NAME["blink-ok"])
        return cv2.imencode(".jpg", image)[1].tobytes()

    def test_detect_returns_a_scene(self, client):
        response = client.post("/detect", files={"image": ("a.jpg", self.encode(), "image/jpeg")}, data={"board": "arduino_uno"})
        assert response.status_code == 200
        assert response.json()["breadboard"]["columns"] == 30

    def test_rejects_an_unknown_board(self, client):
        response = client.post("/detect", files={"image": ("a.jpg", self.encode(), "image/jpeg")}, data={"board": "nope"})
        assert response.status_code == 422

    def test_rejects_a_malformed_alignment(self, client):
        response = client.post("/detect", files={"image": ("a.jpg", self.encode(), "image/jpeg")}, data={"board": "arduino_uno", "quad": "[[1,2]]"})
        assert response.status_code == 422

    def test_rejects_an_undecodable_file(self, client):
        response = client.post("/detect", files={"image": ("a.jpg", b"not an image", "image/jpeg")})
        assert response.status_code == 422
