#!/usr/bin/php -q
<?
/* Unraid's rebuild_container plus the ORG_ENTRYPOINT/ORG_CMD injection its
 * update_container does for TailscaleEnabled templates; without them the
 * Tailscale hook never starts the app. */
$docroot ??= ($_SERVER['DOCUMENT_ROOT'] ?: '/usr/local/emhttp');
require_once "$docroot/plugins/dynamix.docker.manager/include/DockerClient.php";
$DockerClient = new DockerClient();
$DockerUpdate = new DockerUpdate();
$DockerTemplates = new DockerTemplates();
$start  = array_map(function($row){return strtok($row,' ');},@file('/var/lib/docker/unraid-autostart',FILE_IGNORE_NEW_LINES|FILE_SKIP_EMPTY_LINES) ?: []);
$custom = DockerUtil::custom();
$subnet = DockerUtil::network($custom);
$cpus   = DockerUtil::cpus();
$tmpl   = $DockerTemplates->getUserTemplate($argv[1]);
$xml    = file_get_contents($tmpl);
[$cmd,$name,$repository] = xmlToCommand($tmpl);
$old = $DockerClient->getImageID($repository);
removeContainer($name,false,false);

if (getXmlVal($xml, 'TailscaleEnabled') == 'true') {
    exec('/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/docker create --name ' . escapeshellarg($name) . ' ' . escapeshellarg($repository));
    $containerInfo = $DockerClient->getContainerDetails($name);
    $ts_env  = isset($containerInfo['Config']['Entrypoint']) ? '-e ORG_ENTRYPOINT="' . implode(' ', $containerInfo['Config']['Entrypoint']) . '" ' : '';
    $ts_env .= isset($containerInfo['Config']['Cmd']) ? '-e ORG_CMD="' . implode(' ', $containerInfo['Config']['Cmd']) . '" ' : '';
    $cmd = str_replace('-l net.unraid.docker.managed=dockerman', $ts_env . '-l net.unraid.docker.managed=dockerman', $cmd);
    exec('/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/docker rm ' . escapeshellarg($name));
}

execCommand(str_replace('/docker create ','/docker run -d ',$cmd),false);
if (!in_array($name,$start)) stopContainer($name,false,false);
$DockerClient->flushCaches();
$new = $DockerClient->getImageID($repository);
if ($old && $old != $new) removeImage($old,false);
?>
