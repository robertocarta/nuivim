-- A small Lua file: drawn monospace.
local M = {}

function M.greet(name)
  return ("Hello, %s!"):format(name)
end

for i = 1, 3 do
  print(M.greet("world " .. i))
end

return M
