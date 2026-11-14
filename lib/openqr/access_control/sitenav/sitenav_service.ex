defmodule OpenQR.AccessControl.Sitenav.SitenavService do
  require Ash.CodeInterface

  Ash.CodeInterface.define_interface(
    OpenQR.AccessControl.AccessControlService,
    OpenQR.AccessControl.Sitenav
  )
end
