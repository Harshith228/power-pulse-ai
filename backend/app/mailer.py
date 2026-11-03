"""Transactional email (password reset). Uses SMTP when configured; otherwise logs in clearly marked test mode."""
import logging
import smtplib
import ssl
from email.message import EmailMessage

from .config import SMTP

log = logging.getLogger("powerpulse.mail")


def send(to: str, subject: str, text: str) -> str:
    """Return 'sent' or 'test_mode'. Raises on SMTP failure so callers can log it."""
    if not SMTP.live:
        # Test mode: nothing leaves the machine. The message (with any link) goes to the server log only,
        # never to the HTTP response, so it can't be used to take over someone else's account.
        log.warning("EMAIL TEST MODE (SMTP not configured) - not sent.\nTo: %s\nSubject: %s\n\n%s", to, subject, text)
        return "test_mode"
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = SMTP.sender, to, subject
    msg.set_content(text)
    with smtplib.SMTP(SMTP.host, SMTP.port, timeout=20) as s:
        s.starttls(context=ssl.create_default_context())
        if SMTP.user:
            s.login(SMTP.user, SMTP.password)
        s.send_message(msg)
    return "sent"
