# -*- coding: utf-8 -*-
import logging
import importlib
import subprocess
import sys
import os

_logger = logging.getLogger(__name__)

# Python packages this module needs at runtime → pip name
_REQUIRED = {
    'PIL':              'Pillow',
    'arabic_reshaper':  'arabic-reshaper',
    'bidi':             'python-bidi',
}


def _autoinstall_dependencies():
    """Auto-install missing Python deps on the same interpreter Odoo runs on.
    Best-effort: never raises — if install fails, a clear log line tells the admin what to do."""
    missing_pkgs = []
    for module_name, pip_pkg in _REQUIRED.items():
        try:
            importlib.import_module(module_name)
        except ImportError:
            missing_pkgs.append(pip_pkg)

    if not missing_pkgs:
        return

    _logger.info("pos_kot_print: auto-installing missing Python deps: %s", missing_pkgs)
    cmd = [sys.executable, '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check'] + missing_pkgs
    try:
        subprocess.check_call(cmd, stderr=subprocess.STDOUT)
        for module_name in _REQUIRED:
            try:
                importlib.import_module(module_name)
            except ImportError:
                pass
        _logger.info("pos_kot_print: dependencies installed.")
    except Exception as e:
        _logger.warning(
            "pos_kot_print: could not auto-install %s (%s). "
            "Run manually as admin:  \"%s\" -m pip install %s",
            ' '.join(missing_pkgs), e, sys.executable, ' '.join(missing_pkgs),
        )


def _ensure_archive_folder():
    """Create kotprintimage/ inside the module so receipts can be archived."""
    try:
        save_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'kotprintimage')
        os.makedirs(save_dir, exist_ok=True)
        # Drop a small marker so the folder is visible/zippable even when empty
        marker = os.path.join(save_dir, '.gitkeep')
        if not os.path.exists(marker):
            try:
                with open(marker, 'w') as f:
                    f.write('')
            except OSError:
                pass
        _logger.info("pos_kot_print: archive folder ready at %s", save_dir)
    except Exception as e:
        _logger.warning("pos_kot_print: could not create archive folder (%s). KOT printing still works; receipts just won't be archived.", e)


def _post_init_hook(env):
    """Runs once when the module is installed. env is the Odoo environment (Odoo 17+)."""
    _ensure_archive_folder()


_autoinstall_dependencies()
_ensure_archive_folder()

from . import models
