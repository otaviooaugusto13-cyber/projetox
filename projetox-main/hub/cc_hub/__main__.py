"""CLI do hub:
  python -m cc_hub gen-secrets                    gera CC_MASTER_KEY e CC_VIEWER_TOKEN
  python -m cc_hub enroll pc-principal --name "PC Principal" [--epoch 1]
                                                  imprime a chave do agente (derivada da mestra) e as linhas de .env
  python -m cc_hub run [--host 0.0.0.0 --port 5100]   sobe o hub (dev/uso pessoal); em produção use gunicorn
"""
from __future__ import annotations

import argparse
import os
import secrets
import sys

from . import crypto
from .config import AGENT_ID_RE, ConfigError, load_settings


def _load_dotenv() -> None:
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        with open(os.path.join(here, ".env"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except OSError:
        pass


def main(argv=None) -> int:
    _load_dotenv()
    ap = argparse.ArgumentParser(prog="cc_hub")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("gen-secrets")
    en = sub.add_parser("enroll")
    en.add_argument("agent_id")
    en.add_argument("--name", default="")
    en.add_argument("--epoch", type=int, default=1)
    rn = sub.add_parser("run")
    rn.add_argument("--host", default="0.0.0.0")
    rn.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5100")))
    args = ap.parse_args(argv)

    if args.cmd == "gen-secrets":
        print(f"CC_MASTER_KEY={secrets.token_urlsafe(48)}")
        print(f"CC_VIEWER_TOKEN={secrets.token_urlsafe(32)}")
        return 0

    try:
        if args.cmd == "enroll":
            cfg = load_settings()
            aid = args.agent_id.lower()
            if not AGENT_ID_RE.match(aid):
                print("id inválido: use a-z, 0-9, _ e -, de 3 a 40 caracteres", file=sys.stderr)
                return 2
            key = crypto.b64u(crypto.derive_agent_key(cfg.master_key, aid, max(1, args.epoch)))
            at = f"@{args.epoch}" if args.epoch != 1 else ""
            print("# No HUB: acrescente em CC_AGENTS (separado por vírgula):")
            print(f"{aid}{at}:{args.name or aid}\n")
            print("# No AGENTE (agent/.env):")
            print(f"CC_AGENT_ID={aid}\nCC_AGENT_KEY={key}")
            return 0
        if args.cmd in (None, "run"):
            from .server import create_app
            app = create_app()
            host = getattr(args, "host", "0.0.0.0")
            port = getattr(args, "port", int(os.environ.get("PORT", "5100")))
            print(f"[cc_hub] http://{host}:{port}  (coloque TLS na frente: Render, Tailscale Serve ou Caddy)")
            app.run(host=host, port=port, threaded=True)
            return 0
    except ConfigError as e:
        print(f"[erro de configuração] {e}", file=sys.stderr)
        return 2
    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
