defmodule OpenQR.AccessControl.Roles.RoleService do
  require Ash.CodeInterface

  Ash.CodeInterface.define_interface(
    OpenQR.AccessControl.AccessControlService,
    OpenQR.AccessControl.Role
  )
end
