-- propvim bridge: run once with nvim_exec_lua right after the UI attaches.
-- Sends notifications back to the UI on the given channel; changes nothing
-- in the user's config except mapping <D-c>, <D-v> and <D-a> where unmapped.
local chan = ...

-- Lets the user's config tell a propvim session apart (read at draw time, e.g. by
-- decoration providers; it is set after startup, so not visible in init.lua).
vim.g.propvim_ui = 1

local function send(kind, payload)
  pcall(vim.rpcnotify, chan, 'propvim', kind, payload)
end

local function send_config()
  local cfg = vim.g.propvim
  if cfg == nil then
    cfg = vim.empty_dict()
  end
  send('config', cfg)
end

local function map_unmapped(modes, lhs, rhs, desc)
  for _, mode in ipairs(modes) do
    if vim.fn.maparg(lhs, mode) == '' then
      vim.keymap.set(mode, lhs, rhs, { desc = desc })
    end
  end
end

local function paste_clipboard()
  vim.api.nvim_paste(vim.fn.getreg('+'), true, -1)
end

local function setup_maps()
  map_unmapped({ 'x' }, '<D-c>', '"+y', 'propvim: copy')
  map_unmapped({ 'n', 'i', 'c' }, '<D-v>', paste_clipboard, 'propvim: paste')
  map_unmapped({ 'n' }, '<D-a>', 'ggVG', 'propvim: select all')
end

local group = vim.api.nvim_create_augroup('propvim', { clear = true })

vim.api.nvim_create_autocmd({ 'FileType', 'BufWinEnter' }, {
  group = group,
  callback = function()
    send('wininfo', vim.empty_dict())
  end,
})

vim.api.nvim_create_autocmd('OptionSet', {
  group = group,
  pattern = { 'number', 'relativenumber', 'signcolumn', 'foldcolumn', 'numberwidth', 'statuscolumn' },
  callback = function()
    send('wininfo', vim.empty_dict())
  end,
})

vim.api.nvim_create_user_command('PropvimReload', send_config, { desc = 'propvim: re-read vim.g.propvim' })

send_config()

if vim.v.vim_did_enter == 1 then
  setup_maps()
  send('wininfo', vim.empty_dict())
else
  vim.api.nvim_create_autocmd('VimEnter', {
    group = group,
    once = true,
    callback = function()
      send_config()
      setup_maps()
    end,
  })
end
