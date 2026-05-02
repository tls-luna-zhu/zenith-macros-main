"""
Shared CLI UI helpers — colours, prompts, banners, verify flow.
Reused by all standalone CLI apps.
"""
import sys

try:
    from colorama import init as _cinit, Fore, Style
    _cinit(autoreset=True)
except ImportError:
    class _Fake:
        def __getattr__(self, _): return ""
    Fore = Style = _Fake()


def banner(product_name: str, version: str) -> str:
    width = max(len(product_name) + 18, 44)
    title = f"Zenith Macros — {product_name}  v{version}"
    pad   = " " * ((width - len(title)) // 2)
    inner = f"║{pad}{title}{pad}{'║' if (width - len(title)) % 2 == 0 else ' ║'}"
    bar   = "═" * (width - 2)
    return (
        f"\n{Fore.MAGENTA}╔{bar}╗\n"
        f"{inner}\n"
        f"╚{bar}╝{Style.RESET_ALL}\n"
    )


def ok(msg: str)   -> None: print(f"  {Fore.GREEN}✓{Style.RESET_ALL} {msg}")
def err(msg: str)  -> None: print(f"  {Fore.RED}✗{Style.RESET_ALL} {msg}")
def info(msg: str) -> None: print(f"  {Fore.CYAN}→{Style.RESET_ALL} {msg}")
def sep()          -> None: print(f"  {Style.DIM}{'─' * 42}{Style.RESET_ALL}")


def prompt(label: str, default: str = "") -> str:
    hint = f" [{default}]" if default else ""
    val  = input(f"  {label}{hint}: ").strip()
    return val if val else default


def confirm(label: str, default: bool = True) -> bool:
    hint = "Y/n" if default else "y/N"
    val  = input(f"  {label} [{hint}]: ").strip().lower()
    return default if not val else val.startswith("y")


def pause(msg: str = "Press Enter to continue…") -> None:
    input(f"  {msg}")


def do_verify(cfg: dict, product_id: str, cfg_filename: str,
              force: bool = False) -> dict:
    """
    Shared license verify flow used by all CLIs.
    Modifies and returns cfg with updated license_key + session_token.
    """
    import zenith_auth  as auth_mod
    import zenith_config as cfg_mod

    key = cfg.get("license_key", "")
    if not key or force:
        print()
        sep()
        info("Enter your Zenith Macros license key (e.g. XXXX-XXXX-XXXX-XXXX-XXXX)")
        key = prompt("License key")
        if not key:
            err("No key entered.")
            return cfg

    print()
    info("Verifying license…")
    result = auth_mod.verify_license(key, product_id)

    if result["ok"]:
        ok(f"License valid  ({result.get('tier', '?')} plan)")
        ok(f"Entitlement confirmed — {result.get('product_name', product_id)} is yours")
        cfg["license_key"]   = auth_mod.normalize_key(key)
        cfg["session_token"] = result["session_token"]
        cfg_mod.save(cfg_filename, cfg)
    else:
        code = result.get("code", "")
        err(result.get("error", "Verification failed"))
        if code == "no_entitlement":
            info(f"Purchase at: zenithmacros.store/checkout-standalone?product_id={product_id}")
        elif code == "hwid_locked":
            info("Device limit reached. Contact support on Discord.")

    return cfg
