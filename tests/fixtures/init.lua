-- Fixed test config: tests never depend on the user's Neovim config.
vim.opt.swapfile = false
vim.opt.shadafile = 'NONE'
vim.opt.shortmess:append('I')
vim.opt.mouse = 'a'
vim.opt.termguicolors = true
vim.opt.more = false
vim.cmd.colorscheme('default')
-- Like most colorschemes, give inline code its own group (the default scheme
-- leaves @markup.raw undefined, so the UI only ever sees the fallback group).
vim.api.nvim_set_hl(0, '@markup.raw', { fg = '#8ec07c' })
