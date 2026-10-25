Add-Type -AssemblyName System.DirectoryServices.AccountManagement
[DirectoryServices.AccountManagement.UserPrincipal]::Current.GetAuthorizationGroups().SID.Value -contains 'S-1-5-32-544'