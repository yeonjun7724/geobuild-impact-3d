"""Korean narration with MeloTTS (+ g2pkk pronunciation) -> one WAV per line + timings.json.

Run with the MeloTTS venv:
    KMECAB=<dir with python-mecab-ko> python video/tts/synth.py [--speed 1.05]

g2pkk only knows `eunjeon` (no Windows build) on Windows, so it is pointed at python-mecab-ko
(installed into its own --target dir because `mecab` and mecab-python3's `MeCab` collide on
case-insensitive file systems).
"""
import argparse
import json
import os
import re
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "hf" / "assets" / "vo"

# Words the Korean front-end would otherwise spell letter by letter or misread.
PRONOUNCE = [
    (r"GeoBuild Impact 3D", "지오빌드 임팩트 쓰리디"),
    (r"JIRISO DATA STUDIO", "지리소 데이터 스튜디오"),
    (r"\b3D\b", "쓰리디"),
    (r"\bPDF\b", "피디에프"),
    (r"\bNREL\b", "엔렐"),
    (r"\bDEM\b", "수치표고모델"),
    (r"\bLH\b", "엘에이치"),
]


def to_speech(text: str) -> str:
    for pat, rep in PRONOUNCE:
        text = re.sub(pat, rep, text)
    if re.search(r"[A-Za-z0-9]", text):
        raise SystemExit(f"unresolved latin/digits in narration (add a 'say' or a dictionary entry): {text}")
    return text


def patch_g2pkk():
    if os.environ.get("KMECAB"):
        sys.path.insert(0, os.environ["KMECAB"])
    import mecab  # python-mecab-ko
    import g2pkk.g2pkk as G
    G.G2p.check_mecab = lambda self: None
    G.G2p.get_mecab = lambda self: mecab.MeCab()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--speed", type=float, default=1.05)
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args()
    patch_g2pkk()
    from melo.api import TTS
    model = TTS(language="KR", device="cpu")
    spk = model.hps.data.spk2id["KR"]
    OUT.mkdir(parents=True, exist_ok=True)
    script = json.loads((HERE / "script.json").read_text(encoding="utf-8"))
    timings = {}
    for sc in script["scenes"]:
        if a.only and sc["id"] not in a.only:
            continue
        lines = []
        for i, ln in enumerate(sc["lines"]):
            say = to_speech(ln.get("say") or ln["sub"])
            f = OUT / f"{sc['id']}_{i}.wav"
            model.tts_to_file(say, spk, str(f), speed=a.speed, quiet=True)
            with wave.open(str(f)) as w:
                dur = w.getnframes() / w.getframerate()
            lines.append({"file": f"assets/vo/{f.name}", "sub": ln["sub"], "say": say, "dur": round(dur, 3)})
            print(f"{f.name}: {dur:.2f}s  {say}", flush=True)
        timings[sc["id"]] = lines
    tf = OUT / "timings.json"
    old = json.loads(tf.read_text(encoding="utf-8")) if tf.exists() and a.only else {}
    old.update(timings)
    tf.write_text(json.dumps(old, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
