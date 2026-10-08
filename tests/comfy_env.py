"""Boot a real ComfyUI source tree in CPU mode and load the node packs the
Studio drives, so built prompts are checked by ComfyUI itself.

    COMFYUI_ROOT         your ComfyUI folder (the one containing 'comfy') — required
    MMH3_PROMPT_PACK     the comfyui-minimax-h3 (H3 Prompt Compiler) folder
    MMH3_LONGSHOT_PACK   the comfyui-minimax-h3-longshot folder
    STUDIO_EXTRA_NODES   other pack folders, separated by os.pathsep (';' on Windows):
                         ComfyUI-KJNodes, ComfyUI-VideoHelperSuite,
                         ComfyUI-MiniMax-H3-Turbo, ComfyUI-MelBandRoFormer
"""
import asyncio
import os
import sys

_LOADED = None


def boot():
    root = os.environ.get("COMFYUI_ROOT")
    if not root or not os.path.isdir(os.path.join(root, "comfy")):
        raise RuntimeError("Set COMFYUI_ROOT to your ComfyUI folder (the one containing 'comfy').")
    if root not in sys.path:
        sys.path.insert(0, root)
    import comfy.options
    comfy.options.enable_args_parsing(True)
    saved, sys.argv = sys.argv, ["main.py", "--cpu"]
    try:
        import comfy.cli_args  # noqa: F401
    finally:
        sys.argv = saved
    return root


class _StandInServer:
    """Enough of PromptServer for packs that touch it at import (VHS reads
    prompt_queue and registers routes). Nothing is served."""
    client_id = None
    last_node_id = None
    prompt_queue = None

    def __init__(self):
        from aiohttp import web
        self.routes = web.RouteTableDef()
        self.app = web.Application()      # KJNodes adds a static route to it

    def send_sync(self, *args, **kwargs):
        pass

    def __getattr__(self, name):          # add_on_prompt_handler and friends
        return lambda *a, **k: None


def _stand_in_server():
    import server
    if getattr(server.PromptServer, "instance", None) is None:
        server.PromptServer.instance = _StandInServer()


def pack_dirs():
    dirs = [os.environ.get("MMH3_PROMPT_PACK"), os.environ.get("MMH3_LONGSHOT_PACK")]
    dirs += (os.environ.get("STUDIO_EXTRA_NODES") or "").split(os.pathsep)
    return [d for d in dirs if d and os.path.isdir(d)]


def load_packs():
    """Built-in extra nodes plus every pack named in the environment. Returns
    the set of node classes ComfyUI ends up with."""
    global _LOADED
    if _LOADED is not None:
        return _LOADED
    boot()
    import nodes
    _stand_in_server()

    async def go():
        await nodes.init_builtin_extra_nodes()
        for d in pack_dirs():
            await nodes.load_custom_node(os.path.abspath(d))

    asyncio.run(go())
    _LOADED = set(nodes.NODE_CLASS_MAPPINGS)
    return _LOADED
