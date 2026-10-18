-- Fixed test config: tests never depend on the user's Neovim config.
vim.opt.swapfile = false
vim.opt.shadafile = 'NONE'
vim.opt.shortmess:append('I')
vim.opt.mouse = 'a'
vim.opt.termguicolors = true
vim.opt.more = false
vim.cmd.colorscheme('default')
