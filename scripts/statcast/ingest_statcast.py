"""
Daily MLB Statcast batter ingestion via pybaseball → Supabase player_stats_daily.

Env (required):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Usage:
  python ingest_statcast.py                    # incremental: yesterday (America/New_York)
  python ingest_statcast.py --backfill         # last 14 days
  python ingest_statcast.py --start 2025-03-01 --end 2025-03-15

Exit code 1 if zero rows were inserted (for CI failure).
"""

from __future__ import annotations

import argparse
import logging
import random
import sys
import time
from datetime import date, datetime, timedelta
from typing import Any

import pandas as pd
from dotenv import load_dotenv
import os

# Repo root: scripts/statcast -> ../..
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
load_dotenv(os.path.join(ROOT, ".env"))
load_dotenv(os.path.join(ROOT, ".env.local"))

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("ingest_statcast")

RETRIES = 3


def get_supabase():
    from supabase import create_client

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
        sys.exit(1)
    return create_client(url, key)


def eastern_yesterday() -> date:
    from zoneinfo import ZoneInfo

    now = datetime.now(ZoneInfo("America/New_York"))
    return (now.date() - timedelta(days=1))


def fetch_tracked_players(client) -> list[dict[str, Any]]:
    res = client.table("tracked_players").select("player_id, player_name, team, position").execute()
    rows = res.data or []
    if not rows:
        logger.warning("No rows in tracked_players — add players in Supabase")
    return rows


def statcast_batter_with_retry(start: str, end: str, player_id: int) -> pd.DataFrame:
    from pybaseball import statcast_batter

    last_err: Exception | None = None
    for attempt in range(RETRIES):
        try:
            data = statcast_batter(start, end, player_id)
            if data is None:
                return pd.DataFrame()
            return data if isinstance(data, pd.DataFrame) else pd.DataFrame(data)
        except Exception as e:
            last_err = e
            wait = (2**attempt) + random.uniform(0, 1)
            logger.warning(
                "statcast_batter failed player=%s attempt %s/%s: %s — sleeping %.1fs",
                player_id,
                attempt + 1,
                RETRIES,
                e,
                wait,
            )
            time.sleep(wait)
    logger.error("Giving up on player %s: %s", player_id, last_err)
    return pd.DataFrame()


def safe_num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce")


def compute_daily_rows(df: pd.DataFrame, meta: dict[str, Any]) -> list[dict[str, Any]]:
    """Group statcast batter DF by game_date."""
    if df.empty:
        return []

    # Column name variants across pybaseball versions
    def col(*names: str) -> str | None:
        for n in names:
            if n in df.columns:
                return n
        return None

    c_date = col("game_date", "game_date_time")
    c_ls = col("launch_speed")
    c_la = col("launch_angle")
    c_ev = col("estimated_ba_using_speedangle")  # unused
    c_event = col("events", "description")
    c_game = col("game_pk")
    c_ab = col("at_bat_number")

    if c_date is None:
        logger.warning("No date column in statcast frame: %s", list(df.columns)[:20])
        return []

    df = df.copy()
    df["_d"] = pd.to_datetime(df[c_date], errors="coerce").dt.date
    df = df[df["_d"].notna()]
    if df.empty:
        return []

    if c_ls:
        df["_ls"] = safe_num(df[c_ls])
    else:
        df["_ls"] = float("nan")
    if c_la:
        df["_la"] = safe_num(df[c_la])
    else:
        df["_la"] = float("nan")

    out: list[dict[str, Any]] = []
    for d, g in df.groupby("_d"):
        pa = 0
        if c_game and c_ab:
            keys = g[[c_game, c_ab]].drop_duplicates()
            pa = len(keys)
        else:
            pa = len(g)

        ls = g["_ls"]
        la = g["_la"]
        valid_bb = ls.notna() & la.notna()

        barrels = int(
            ((ls >= 98) & (la >= 26) & (la <= 30) & valid_bb).sum()
        )
        batted = int(valid_bb.sum())
        hard_hit = int(((ls >= 95) & valid_bb).sum())
        fly_ball = int(((la > 10) & valid_bb).sum())

        hr = 0
        if c_event:
            ev = g[c_event].astype(str).str.lower()
            hr = int(ev.str.contains("home_run", na=False).sum())

        avg_ev = float(ls[valid_bb].mean()) if batted else None
        barrel_rate = (barrels / batted) if batted else None
        hard_hit_rate = (hard_hit / batted) if batted else None
        fly_ball_rate = (fly_ball / batted) if batted else None

        out.append(
            {
                "player_id": int(meta["player_id"]),
                "player_name": meta.get("player_name"),
                "team": meta.get("team"),
                "position": meta.get("position"),
                "date": d.isoformat() if hasattr(d, "isoformat") else str(d),
                "plate_appearances": int(pa),
                "home_runs": hr,
                "barrels": barrels,
                "barrel_rate": barrel_rate,
                "hard_hit_rate": hard_hit_rate,
                "avg_exit_velo": avg_ev,
                "fly_ball_rate": fly_ball_rate,
            }
        )
    return out


def upsert_daily(client, rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    # Batch to avoid payload limits
    n = 0
    chunk = 80
    for i in range(0, len(rows), chunk):
        part = rows[i : i + chunk]
        try:
            client.table("player_stats_daily").upsert(part, on_conflict="player_id,date").execute()
            n += len(part)
        except Exception as e:
            logger.error("Upsert failed: %s", e)
            raise
    return n


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--backfill", action="store_true", help="Load last 14 days (Eastern calendar)")
    p.add_argument("--start", type=str, help="YYYY-MM-DD")
    p.add_argument("--end", type=str, help="YYYY-MM-DD")
    return p.parse_args()


def resolve_range(args) -> tuple[date, date]:
    if args.start and args.end:
        return date.fromisoformat(args.start), date.fromisoformat(args.end)
    if args.backfill:
        end = eastern_yesterday()
        start = end - timedelta(days=13)
        return start, end
    d = eastern_yesterday()
    return d, d


def main():
    args = parse_args()
    start_d, end_d = resolve_range(args)
    start_s = start_d.isoformat()
    end_s = end_d.isoformat()
    logger.info("Date range %s .. %s (inclusive)", start_s, end_s)

    client = get_supabase()
    players = fetch_tracked_players(client)
    if not players:
        logger.error("No tracked players — exiting")
        sys.exit(1)

    total_inserted = 0
    for pl in players:
        pid = int(pl["player_id"])
        df = statcast_batter_with_retry(start_s, end_s, pid)
        if df.empty:
            logger.warning("No statcast rows for player %s (%s)", pid, pl.get("player_name"))
            continue
        rows = compute_daily_rows(df, pl)
        if not rows:
            logger.warning("No daily aggregates for player %s", pid)
            continue
        n = upsert_daily(client, rows)
        total_inserted += n
        logger.info("Player %s: upserted %s daily rows", pid, n)

    logger.info("Total rows upserted: %s", total_inserted)
    if total_inserted == 0:
        logger.error("Zero rows inserted — failing for CI")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
