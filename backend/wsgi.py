"""
WSGI entry point for PythonAnywhere.

In the PythonAnywhere web app configuration set:
  Source code:       /home/<username>/zenith-macros-backend
  Working directory: /home/<username>/zenith-macros-backend
  WSGI file:         /home/<username>/zenith-macros-backend/wsgi.py
"""

import os
import sys

# Ensure the backend package directory is on the path
sys.path.insert(0, os.path.dirname(__file__))

from app import create_app

application = create_app()
