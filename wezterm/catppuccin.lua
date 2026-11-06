-- Session Slayer WezTerm theme: Catppuccin, JetBrains Mono, macOS keys. Copy to ~/.wezterm.lua and change what you like.
local wezterm = require 'wezterm'
local config = wezterm.config_builder()

-- Colors follow the macOS light / dark setting.
local function scheme()
  local dark = (wezterm.gui and wezterm.gui.get_appearance() or 'Dark'):find('Dark')
  return dark and 'Catppuccin Mocha' or 'Catppuccin Latte'
end
config.color_scheme = scheme()

-- Font: JetBrains Mono ships with WezTerm, so no install is needed.
config.font = wezterm.font_with_fallback { 'JetBrains Mono', 'Menlo' }
config.font_size = 13.0
config.line_height = 1.1

-- Window
config.initial_cols = 140
config.initial_rows = 40
config.window_padding = { left = 12, right = 12, top = 8, bottom = 8 }
config.window_decorations = 'RESIZE|INTEGRATED_BUTTONS'
config.native_macos_fullscreen_mode = true

-- Tabs: one tab per agent session, so keep the bar readable.
config.use_fancy_tab_bar = true
config.hide_tab_bar_if_only_one_tab = false
config.tab_max_width = 32
config.show_new_tab_button_in_tab_bar = true

-- Cursor and scrolling
config.default_cursor_style = 'BlinkingBar'
config.scrollback_lines = 20000
config.audible_bell = 'Disabled'

-- Left Option types special characters; right Option works as Alt (word jumps in the shell).
config.send_composed_key_when_left_alt_is_pressed = true
config.send_composed_key_when_right_alt_is_pressed = false

config.keys = {
  -- Cmd+Left / Cmd+Right: start / end of line. Option+Left / Option+Right: word back / forward.
  { key = 'LeftArrow', mods = 'CMD', action = wezterm.action.SendString '\x01' },
  { key = 'RightArrow', mods = 'CMD', action = wezterm.action.SendString '\x05' },
  { key = 'LeftArrow', mods = 'OPT', action = wezterm.action.SendString '\x1bb' },
  { key = 'RightArrow', mods = 'OPT', action = wezterm.action.SendString '\x1bf' },
  -- Shift+Enter: new line in the Claude Code prompt instead of sending it.
  { key = 'Enter', mods = 'SHIFT', action = wezterm.action.SendString '\x1b\r' },
  -- Cmd+D / Cmd+Shift+D: split right / down.
  { key = 'd', mods = 'CMD', action = wezterm.action.SplitHorizontal { domain = 'CurrentPaneDomain' } },
  { key = 'd', mods = 'CMD|SHIFT', action = wezterm.action.SplitVertical { domain = 'CurrentPaneDomain' } },
}

return config
