-- nuivim bridge: run once with nvim_exec_lua right after the UI attaches.
-- Sends notifications back to the UI on the given channel; changes nothing
-- in the user's config except mapping <D-c>, <D-v> and <D-a> where unmapped.
local chan = ...

-- Lets the user's config tell a nuivim session apart (read at draw time, e.g. by
-- decoration providers; it is set after startup, so not visible in init.lua).
vim.g.nuivim_ui = 1

local function send(kind, payload)
  pcall(vim.rpcnotify, chan, 'nuivim', kind, payload)
end

local function send_config()
  local cfg = vim.g.nuivim
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
  map_unmapped({ 'x' }, '<D-c>', '"+y', 'nuivim: copy')
  map_unmapped({ 'n', 'i', 'c' }, '<D-v>', paste_clipboard, 'nuivim: paste')
  map_unmapped({ 'n' }, '<D-a>', 'ggVG', 'nuivim: select all')
end

local group = vim.api.nvim_create_augroup('nuivim', { clear = true })

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

-- The tab's title: the current file of a normal window, and the working directory.
local function send_buf()
  if vim.bo.buftype ~= '' or vim.api.nvim_win_get_config(0).relative ~= '' then
    return
  end
  send('buf', { name = vim.api.nvim_buf_get_name(0), cwd = vim.fn.getcwd() })
end

vim.api.nvim_create_autocmd({ 'BufEnter', 'BufFilePost', 'DirChanged', 'VimEnter' }, {
  group = group,
  callback = send_buf,
})

vim.api.nvim_create_user_command('NuivimReload', send_config, { desc = 'nuivim: re-read vim.g.nuivim' })

send_config()

if vim.v.vim_did_enter == 1 then
  setup_maps()
  send_buf()
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
