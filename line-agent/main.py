# The brain test line's Line agent (docs/calls-brain-first.md "Test line"). Cartesia runs the ears, the voice,
# turn-taking and interruptions; every sentence spoken comes from Reason's speaking brain over HTTPS
# (BRAIN_URL, with BRAIN_SECRET as a bearer token: both in Cartesia's agent env, never in this file).
# The caller gate is on our side (/brain-test/start): anyone but the owner hears one fixed line and the call ends.
import json
import os

import httpx
from line.events import AgentEndCall, AgentSendText, AgentTextSent, CallEnded, CallStarted, UserTextSent, UserTurnEnded
from line.voice_agent_app import AgentEnv, CallRequest, PreCallResult, VoiceAgentApp

BRAIN_URL = os.environ.get("BRAIN_URL", "").rstrip("/")
GEMMA = "62ae83ad-4f6a-430b-af41-a9bede9286ca"
PRIVATE_LINE = "This is a private test line."
SORRY = "Sorry, I lost my train of thought there. Say that again?"


def _headers():
    return {"Authorization": f"Bearer {os.environ.get('BRAIN_SECRET', '')}", "Content-Type": "application/json"}


def _history(event):
    out = []
    for e in event.history or []:
        if isinstance(e, UserTextSent):
            role, text = "user", e.content
        elif isinstance(e, AgentTextSent):
            role, text = "assistant", e.content
        else:
            continue
        text = (text or "").strip()
        if not text:
            continue
        if out and out[-1]["role"] == role:
            out[-1]["content"] += " " + text
        else:
            out.append({"role": role, "content": text})
    return out


class BrainAgent:
    def __init__(self, call_request: CallRequest, start: dict):
        self.call_id = call_request.call_id
        self.agent_call_id = call_request.agent_call_id
        self.start = start

    async def process(self, env, event):
        if isinstance(event, CallStarted):
            if not self.start.get("ok"):
                yield AgentSendText(text=self.start.get("say") or PRIVATE_LINE, interruptible=False)
                yield AgentEndCall()
                return
            yield AgentSendText(text=self.start.get("greeting") or "Hey, it's Reason. What's up?")
            return
        if isinstance(event, CallEnded):
            try:
                async with httpx.AsyncClient(timeout=10) as c:
                    await c.post(f"{BRAIN_URL}/brain-test/end", headers=_headers(), json={"call_id": self.call_id, "agent_call_id": self.agent_call_id})
            except Exception:
                pass
            return
        if not isinstance(event, UserTurnEnded) or not self.start.get("ok"):
            return
        history = _history(event)
        now = " ".join((c.content or "").strip() for c in (event.content or []) if isinstance(c, UserTextSent)).strip()
        if now and not (history and history[-1]["role"] == "user" and now in history[-1]["content"]):
            history.append({"role": "user", "content": now})
        said = False
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30, connect=5)) as c:
                async with c.stream("POST", f"{BRAIN_URL}/brain-test/turn", headers=_headers(), json={"call_id": self.call_id, "history": history}) as r:
                    if r.status_code != 200:
                        raise RuntimeError(f"brain {r.status_code}")
                    async for line in r.aiter_lines():
                        if not line.strip():
                            continue
                        ev = json.loads(line)
                        if ev.get("type") == "say" and (ev.get("text") or "").strip():
                            said = True
                            yield AgentSendText(text=ev["text"])
                        elif ev.get("type") == "end_call":
                            yield AgentEndCall()
                            return
        except Exception:
            if not said:
                yield AgentSendText(text=SORRY)


async def pre_call_handler(call_request: CallRequest):
    return PreCallResult(config={"tts": {"voice_id": GEMMA, "model": "sonic-3.6", "language": "en"}})


async def get_agent(env: AgentEnv, call_request: CallRequest):
    start = {"ok": False, "say": PRIVATE_LINE}
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.post(f"{BRAIN_URL}/brain-test/start", headers=_headers(), json={"call_id": call_request.call_id, "from": call_request.from_, "metadata": call_request.metadata or {}})
            if r.status_code == 200:
                start = r.json()
    except Exception:
        pass
    return BrainAgent(call_request, start)


app = VoiceAgentApp(get_agent=get_agent, pre_call_handler=pre_call_handler)

if __name__ == "__main__":
    app.run()
