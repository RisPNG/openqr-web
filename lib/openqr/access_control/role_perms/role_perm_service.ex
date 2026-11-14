defmodule OpenQR.AccessControl.RolePerms.RolePermService do
  require Ash.CodeInterface

  Ash.CodeInterface.define_interface(
    OpenQR.AccessControl.AccessControlService,
    OpenQR.AccessControl.RolePerm
  )
end
