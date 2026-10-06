"""Pricing rules. All money maths lives here so the frontend only displays what the server computes.

Rules (V1):
  - 10 free models per usage window, 15 more at INR 2 each (25 per window).
  - Video lectures: INR 2 per model that has a video.
  - Team of 2: +5% on the subtotal.
  - Quiz: INR 0.25 per correct answer (max 7), never more than 50% of the bill.
  - The final amount is rounded to a whole rupee (UPI QR is static, no paise tricks).
  - Reports: first 2 free, then INR 5 each.
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

FREE_MODELS = 10
PAID_MODELS = 15
MODEL_PRICE = Decimal("2")
VIDEO_PRICE = Decimal("2")
TEAM_SURCHARGE = Decimal("0.05")
QUIZ_PER_CORRECT = Decimal("0.25")
QUIZ_MAX_SHARE = Decimal("0.5")
REPORT_PRICE = Decimal("5")
FREE_REPORTS = 2
QUIZ_QUESTIONS = 7


def _f(d: Decimal) -> float:
    return float(d.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def quote(
    *,
    models: int,
    free_remaining: int,
    video_models: int = 0,
    team: bool = False,
    quiz_correct: int = 0,
) -> dict:
    """Return a full price breakdown for a model run."""
    models = max(0, int(models))
    free_remaining = max(0, int(free_remaining))
    video_models = max(0, min(int(video_models), models))
    quiz_correct = max(0, min(int(quiz_correct), QUIZ_QUESTIONS))

    paid_models = max(0, models - free_remaining)
    free_models = models - paid_models
    models_cost = MODEL_PRICE * paid_models
    video_cost = VIDEO_PRICE * video_models
    subtotal = models_cost + video_cost
    team_cost = (subtotal * TEAM_SURCHARGE) if team else Decimal("0")
    gross = subtotal + team_cost
    quiz_discount = min(QUIZ_PER_CORRECT * quiz_correct, gross * QUIZ_MAX_SHARE)
    net = gross - quiz_discount
    total = int(net.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    if gross > 0 and total < 1:
        total = 1

    lines = []
    if paid_models:
        lines.append({"label": f"{paid_models} model(s) above free tier x INR 2", "amount": _f(models_cost)})
    if video_models:
        lines.append({"label": f"{video_models} video lecture(s) x INR 2", "amount": _f(video_cost)})
    if team_cost:
        lines.append({"label": "Team of 2 surcharge (5%)", "amount": _f(team_cost)})
    if quiz_discount:
        lines.append({"label": f"Quiz discount ({quiz_correct} correct)", "amount": -_f(quiz_discount)})

    return {
        "models": models,
        "free_models": free_models,
        "paid_models": paid_models,
        "video_models": video_models,
        "team": team,
        "quiz_correct": quiz_correct,
        "lines": lines,
        "subtotal": _f(subtotal),
        "gross": _f(gross),
        "quiz_discount": _f(quiz_discount),
        "total": total,  # whole rupees, what the user actually pays
        "needs_payment": total > 0,
    }


def report_quote(reports_used: int) -> dict:
    free_left = max(0, FREE_REPORTS - reports_used)
    return {
        "free_left": free_left,
        "total": 0 if free_left else int(REPORT_PRICE),
        "needs_payment": free_left == 0,
    }
