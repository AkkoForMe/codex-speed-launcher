// Windows WPF is part of the OS. The shipped executable needs no browser,
// Electron runtime, installed Node.js, or network assets for this window.
export function windowsGuiScript() {
  return String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$client = New-Object System.Net.WebClient
$client.Proxy = $null
$client.Encoding = [System.Text.Encoding]::UTF8
$client.Headers['Authorization'] = 'Bearer ' + $env:CODEX_SPEED_GUI_TOKEN
$endpoint = $env:CODEX_SPEED_GUI_ENDPOINT
$script:lastState = $null
$script:allowClose = $false
[xml]$markup = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="Codex Speed Launcher" Width="426" Height="510" MinWidth="426" MinHeight="510" ResizeMode="CanMinimize" WindowStartupLocation="CenterScreen" Background="#F5F6F8" FontFamily="Segoe UI, Microsoft YaHei UI" Foreground="#172031">
  <Window.Resources>
    <Style TargetType="Button">
      <Setter Property="Height" Value="42"/><Setter Property="FontSize" Value="13"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Background" Value="White"/><Setter Property="Foreground" Value="#344054"/><Setter Property="BorderBrush" Value="#DCE1E8"/>
      <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button"><Border x:Name="Frame" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="1" CornerRadius="9"><ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/></Border><ControlTemplate.Triggers><Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Frame" Property="Opacity" Value="0.82"/></Trigger><Trigger Property="IsEnabled" Value="False"><Setter TargetName="Frame" Property="Opacity" Value="0.4"/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter>
    </Style>
  </Window.Resources>
  <Grid Margin="26,22,26,20"><Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
    <StackPanel><TextBlock Text="CODEX SPEED" FontSize="11" FontWeight="SemiBold" Foreground="#8A94A5"/><TextBlock Text="Codex 启动器" FontSize="23" FontWeight="SemiBold" Margin="0,6,0,19"/></StackPanel>
    <Border Grid.Row="1" Background="White" CornerRadius="13" Padding="18,17" BorderBrush="#E5E8EE" BorderThickness="1">
      <StackPanel><StackPanel Orientation="Horizontal"><Ellipse x:Name="StatusDot" Width="8" Height="8" Fill="#9AA4B2" Margin="0,0,8,0"/><TextBlock x:Name="Status" Text="正在检查 Codex…" FontSize="14" FontWeight="SemiBold"/></StackPanel>
        <Grid Margin="0,18,0,0"><Grid.ColumnDefinitions><ColumnDefinition Width="70"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions><Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions><TextBlock Text="Codex 版本" Foreground="#8A94A5" FontSize="11"/><TextBlock x:Name="Version" Grid.Column="1" Text="—" FontSize="12" TextAlignment="Right"/><TextBlock Grid.Row="1" Text="配置模型" Foreground="#8A94A5" FontSize="11" Margin="0,10,0,0"/><TextBlock x:Name="Model" Grid.Row="1" Grid.Column="1" Text="—" FontSize="12" TextAlignment="Right" Margin="0,10,0,0" TextTrimming="CharacterEllipsis"/></Grid>
      </StackPanel>
    </Border>
    <StackPanel Grid.Row="2" Margin="0,19,0,0"><Button x:Name="Primary" Content="启动 Codex" Background="#2563EB" Foreground="White" BorderBrush="#2563EB" FontWeight="SemiBold" IsEnabled="False"/><Grid Margin="0,10,0,0"><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="10"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions><Button x:Name="Refresh" Content="刷新状态" IsEnabled="False"/><Button x:Name="Exit" Grid.Column="2" Content="退出启动器"/></Grid></StackPanel>
    <ScrollViewer Grid.Row="3" Margin="1,14,1,8" VerticalScrollBarVisibility="Auto"><TextBlock x:Name="Detail" FontSize="11" Foreground="#778296" TextWrapping="Wrap"/></ScrollViewer>
    <TextBlock Grid.Row="4" Text="Standard / Fast · 保留现有连接与模型" Foreground="#98A1AF" FontSize="10" HorizontalAlignment="Center"/>
  </Grid>
</Window>
'@
$reader = New-Object System.Xml.XmlNodeReader $markup
$window = [Windows.Markup.XamlReader]::Load($reader)
$status = $window.FindName('Status'); $dot = $window.FindName('StatusDot')
$version = $window.FindName('Version'); $model = $window.FindName('Model'); $detail = $window.FindName('Detail')
$primary = $window.FindName('Primary'); $refresh = $window.FindName('Refresh'); $exit = $window.FindName('Exit')
function Send-Action([string]$action) {
  try { $null = $client.UploadString($endpoint + '/action', 'POST', $action); $primary.IsEnabled = $false; $refresh.IsEnabled = $false; $exit.IsEnabled = $false }
  catch { $detail.Text = '暂时无法连接启动器，请稍候。' }
}
$primary.Add_Click({
  if ($script:lastState.managed) {
    $answer = [Windows.MessageBox]::Show($window, '请先等待 Codex 中的任务完成并保存工作。现在退出并重新启动本次 Codex？', '重启 Codex', 'YesNo', 'Question', 'No')
    if ($answer -eq 'Yes') { Send-Action 'restart' }
  } else { Send-Action 'start' }
})
$refresh.Add_Click({ Send-Action 'refresh' })
function Request-Exit {
  if ($script:lastState.busy) { return }
  if ($script:lastState.managed) {
    $answer = [Windows.MessageBox]::Show($window, '退出启动器也会退出本次启动的 Codex。请等待任务结束并保存工作。现在退出？', '退出启动器', 'YesNo', 'Question', 'No')
    if ($answer -ne 'Yes') { return }
  }
  Send-Action 'quit'
}
$exit.Add_Click({ if ($script:allowClose) { $window.Close() } else { Request-Exit } })
$window.Add_Closing({ param($sender, $eventArgs) if (-not $script:allowClose) { $eventArgs.Cancel = $true; Request-Exit } })
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(700)
$timer.Add_Tick({
  try {
    $s = $client.DownloadString($endpoint + '/state') | ConvertFrom-Json
    $script:lastState = $s
    $script:allowClose = $false; $exit.Content = '退出启动器'
    $status.Text = $s.status; $version.Text = $s.version; $model.Text = $s.model; $detail.Text = $s.detail
    $dot.Fill = if ($s.phase -eq 'running') { '#22A06B' } elseif ($s.phase -eq 'error') { '#D97736' } elseif ($s.busy) { '#2563EB' } else { '#9AA4B2' }
    $primary.Content = if ($s.managed) { '重启 Codex' } else { '启动 Codex' }
    $primary.IsEnabled = -not $s.busy -and $s.compatible -and (-not $s.externalRunning -or $s.managed)
    $refresh.IsEnabled = -not $s.busy -and -not $s.managed
    $exit.IsEnabled = -not $s.busy
    if ($s.closed) { $script:allowClose = $true; $timer.Stop(); $window.Close() }
  } catch { $status.Text = '启动器连接已断开'; $detail.Text = '请先保存工作并退出 Codex，再重新打开启动器。'; $primary.IsEnabled = $false; $refresh.IsEnabled = $false; $exit.IsEnabled = $true; $exit.Content = '关闭窗口'; $script:allowClose = $true }
})
$timer.Start()
try { $null = $window.ShowDialog() } finally { $timer.Stop(); $client.Dispose() }
`;
}
