$builtInRIDs = '-(500|501|503|504|509)$'

# 管理员判定：先把 Administrators 组成员的 SID 收进哈希表，再逐个用户查表。
# 用知名 SID S-1-5-32-544 而不是组名 'Administrators'：内置组名在非英文系统上可能被本地化，
# SID 则全球一致。Get-LocalGroupMember 在域不可达等场景会抛异常（例如组里含解析不了的域账户），
# 这里 try/catch 兜底：读不到就全体按非管理员处理，不让整个用户列表采集失败。
$adminSids = @{}
try {
    Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop |
        ForEach-Object { if ($_.SID) { $adminSids[$_.SID.Value] = $true } }
} catch {
    # 拿不到管理员组成员时静默降级，IsAdmin 一律输出 $false
}

Get-LocalUser |
    Where-Object {
        $_.Enabled -eq $true -and
        $_.SID.Value -notmatch $builtInRIDs -and
        $_.SID.Value -notmatch '^S-1-11-96' -and
        $_.PrincipalSource -ne 'MicrosoftAccount'
    } |
    Select-Object Name,
                  @{Name='DisplayName';Expression={ if ($_.FullName) { $_.FullName } else { $_.Name } }},
                  Enabled,
                  PrincipalSource,
                  @{Name='SID';      Expression={ $_.SID.Value }},
                  @{Name='IsAdmin';  Expression={ $adminSids.ContainsKey($_.SID.Value) }},
                  @{Name='LastLogon';Expression={ if ($_.LastLogon) { $_.LastLogon.ToString('o') } else { $null } }},
                  Description |
    ConvertTo-Json -Depth 3
