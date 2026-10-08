"""H3 Long Shot Studio — a browser front end for MiniMax H3 Long Shot, served
by ComfyUI at http://<comfy>/longshot. Adds no nodes; it builds and queues
graphs that use the H3 Prompt Compiler and H3 Long Shot packs."""

import logging

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from . import studio_server
    studio_server.register()
except Exception:   # never take ComfyUI down with us
    logging.getLogger("H3LongShotStudio").exception("H3 Long Shot Studio failed to start")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
