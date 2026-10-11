#!/usr/bin/env python3
# Linux test helper: run a command inside a NAMED session keyring (KEYRING_NAME, default
# flightsim-smoke) so separate app launches share OS secure storage like one desktop login session.
# Keep one holder process alive (e.g. `linux-session-keyring.py sleep 7200 &`) or the keyring is freed.
# Usage: KEYRING_NAME=x scripts/linux-session-keyring.py <command> [args...]   (x86_64 syscall numbers)
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
KEYCTL, KEYCTL_JOIN_SESSION_KEYRING = 250, 1
name = os.environ.get("KEYRING_NAME", "flightsim-smoke").encode()
if libc.syscall(KEYCTL, KEYCTL_JOIN_SESSION_KEYRING, ctypes.c_char_p(name)) < 0:
    sys.exit(f"join session keyring failed: errno {ctypes.get_errno()}")
# Allow later launches by the same user to find and re-join it (USR search/view/read/write/link).
libc.syscall(KEYCTL, 5, ctypes.c_int(-3), ctypes.c_uint(0x3f3f0000))
os.execvp(sys.argv[1], sys.argv[1:])
