-- Session Slayer WezTerm theme: Solarized Dark, Monaco, big font, smart Cmd+C / Cmd+V for Claude Code.
-- Copy to ~/.wezterm.lua. Monaco for Powerline is not bundled: without it WezTerm uses Menlo.
local wezterm = require 'wezterm'
local config = wezterm.config_builder()

config.font = wezterm.font_with_fallback { 'Monaco for Powerline', 'Menlo' }
config.font_size = 20.0
-- Turn off ligatures (Monaco glues "fi"/"fl" into one glyph)
config.harfbuzz_features = { 'calt=0', 'clig=0', 'liga=0' }
config.color_scheme = 'Builtin Solarized Dark'

-- Tab bar (window frame) font
config.window_frame = {
  font = wezterm.font_with_fallback { { family = 'Monaco for Powerline', harfbuzz_features = { 'calt=0', 'clig=0', 'liga=0' } }, 'Menlo' },
  font_size = 16.0,
}

-- Move the current tab left / right
config.keys = {
  { key = 'LeftArrow', mods = 'CMD|SHIFT', action = wezterm.action.MoveTabRelative(-1) },
  { key = 'RightArrow', mods = 'CMD|SHIFT', action = wezterm.action.MoveTabRelative(1) },
  -- Cmd+V: paste text, or send Ctrl+V when the clipboard holds only an image (Claude Code reads it)
  {
    key = 'v',
    mods = 'CMD',
    action = wezterm.action_callback(function(window, pane)
      local _, text = wezterm.run_child_process { 'pbpaste' }
      if text == nil or text == '' then
        window:perform_action(wezterm.action.SendKey { key = 'v', mods = 'CTRL' }, pane)
      else
        window:perform_action(wezterm.action.PasteFrom 'Clipboard', pane)
      end
    end),
  },
  -- Cmd+C: copy WezTerm's selection, or pass Ctrl+Shift+C to apps that select text themselves (Claude Code)
  {
    key = 'c',
    mods = 'CMD',
    action = wezterm.action_callback(function(window, pane)
      if window:get_selection_text_for_pane(pane) ~= '' then
        window:perform_action(wezterm.action.CopyTo 'Clipboard', pane)
      else
        window:perform_action(wezterm.action.SendKey { key = 'c', mods = 'CTRL|SHIFT' }, pane)
      end
    end),
  },
}


return config
