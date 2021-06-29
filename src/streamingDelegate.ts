import {
  APIEvent,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  CameraControllerOptions,
  CameraStreamingDelegate,
  HAP,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  SRTPCryptoSuites,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
  StreamRequestTypes,
  Logger,
  VideoInfo,
} from 'homebridge';
import { spawn } from 'child_process';
import { createSocket, Socket } from 'dgram';
import ffmpegPath from 'ffmpeg-for-homebridge';
import { Camera, Station, StreamMetadata, VideoCodec } from 'eufy-security-client';
import { EufySecurityPlatform } from './platform';
import getPort from 'get-port';
import os from 'os';
import { networkInterfaceDefault } from 'systeminformation';
import { FfmpegProcess } from './ffmpeg';
import { Readable } from 'stream';
import ffmpeg from 'fluent-ffmpeg';
import { stdout } from 'process';

  type SessionInfo = {
    address: string; // address of the HAP controller
    localAddress: string;
    ipv6: boolean;
  
    videoPort: number;
    videoReturnPort: number;
    videoCryptoSuite: SRTPCryptoSuites; // should be saved if multiple suites are supported
    videoSRTP: Buffer; // key and salt concatenated
    videoSSRC: number; // rtp synchronisation source
  
    audioPort: number;
    audioReturnPort: number;
    audioCryptoSuite: SRTPCryptoSuites;
    audioSRTP: Buffer;
    audioSSRC: number;
  };
  
  type ResolutionInfo = {
    width: number;
    height: number;
    videoFilter: string;
  };
  
  type ActiveSession = {
    mainProcess?: FfmpegProcess;
    returnProcess?: FfmpegProcess;
    timeout?: NodeJS.Timeout;
    socket?: Socket;
  };

  type StationStream = {
    station: Station;
    channel: number; 
    metadata: StreamMetadata; 
    videostream: Readable; 
    audiostream: Readable;
  };
  
export class EufyCameraStreamingDelegate implements CameraStreamingDelegate {
    private readonly hap: HAP;
    private readonly log: Logger;
    private readonly cameraName: string;
    // private readonly videoConfig: VideoConfig;
    private readonly videoProcessor: string;
    private readonly interfaceName?: string;
    private readonly platform: EufySecurityPlatform;
    private readonly device: Camera;
  
    readonly controller: CameraController;
  
    private debug = true;
    private audio = true;
  
    // keep track of sessions
    pendingSessions: Record<string, SessionInfo> = {};
    ongoingSessions: Record<string, ActiveSession> = {};
    timeouts: Record<string, NodeJS.Timeout> = {};
  
    constructor(platform: EufySecurityPlatform, device: Camera) {
      this.log = platform.log;
      this.hap = platform.api.hap;
      this.platform = platform;
      this.device = device;
  
      this.cameraName = device.getName();
      this.videoProcessor = ffmpegPath || 'ffmpeg';
  
      platform.api.on(APIEvent.SHUTDOWN, () => {
        for (const session in this.ongoingSessions) {
          this.stopStream(session);
        }
      });
  
      const options: CameraControllerOptions = {
        cameraStreamCount: 2, // HomeKit requires at least 2 streams, but 1 is also just fine
        delegate: this,
        streamingOptions: {
          supportedCryptoSuites: [
            this.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80,
          ],
          video: {
            resolutions: [
              [320, 180, 30],
              [320, 240, 15], // Apple Watch requires this configuration
              [320, 240, 30],
              [480, 270, 30],
              [480, 360, 30],
              [640, 360, 30],
              [640, 480, 30],
              [1280, 720, 30],
              [1280, 960, 30],
              [1920, 1080, 30],
              [1600, 1200, 30],
            ],
            codec: {
              profiles: [
                this.hap.H264Profile.BASELINE,
                this.hap.H264Profile.MAIN,
                this.hap.H264Profile.HIGH,
              ],
              levels: [
                this.hap.H264Level.LEVEL3_1,
                this.hap.H264Level.LEVEL3_2,
                this.hap.H264Level.LEVEL4_0,
              ],
            },
          },
          audio: {
            twoWayAudio: false, // !!this.videoConfig.returnAudioTarget,
            codecs: [
              {
                type: AudioStreamingCodecType.AAC_ELD,
                samplerate: AudioStreamingSamplerate.KHZ_16,
              },
            ],
          },
        },
      };
  
      this.controller = new this.hap.CameraController(options);
    }
  
    private determineResolution(
      request: SnapshotRequest | VideoInfo,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      isSnapshot: boolean,
    ): ResolutionInfo {
      const width = request.width;
      const height = request.height;
      //   if (!isSnapshot) {
      //     if ((this.videoConfig.forceMax && this.videoConfig.maxWidth) ||
      //       (request.width > this.videoConfig.maxWidth)) {
      //       width = this.videoConfig.maxWidth;
      //     }
      //     if ((this.videoConfig.forceMax && this.videoConfig.maxHeight) ||
      //       (request.height > this.videoConfig.maxHeight)) {
      //       height = this.videoConfig.maxHeight;
      //     }
      //   }
  
      const filters: Array<string> = ['scale=1280:720'];
      const noneFilter = filters.indexOf('none');
      if (noneFilter >= 0) {
        filters.splice(noneFilter, 1);
      }
      if (noneFilter < 0) {
        if (width > 0 || height > 0) {
          //   filters.push('scale=' + (width > 0 ? '\'min(' + width + ',iw)\'' : 'iw') + ':' +
          //     (height > 0 ? '\'min(' + height + ',ih)\'' : 'ih') +
          //     ':force_original_aspect_ratio=decrease');
          //   filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2'); // Force to fit encoder restrictions
          filters.push('scale=\'trunc(iw/2)*2\':\'trunc(ih/2)*2\''); // Force to fit encoder restrictions
        }
      }
  
      return {
        width: width,
        height: height,
        videoFilter: filters.join(','),
      };
    }
  
    async handleSnapshotRequest(
      request: SnapshotRequest,
      callback: SnapshotRequestCallback,
    ): Promise<void> {
      const resolution = this.determineResolution(request, true);
  
      // Here we create and await our promise:
      const streamData:StationStream = await new Promise((resolve, reject) => {
        this.platform.eufyClient.startStationLivestream(this.device.getSerial());

        // Here invoke our event emitter:
        const station = this.platform.getStationById(this.device.getStationSerial());
        // a normal event callback:
        station.on('livestream start', (station: Station, channel:number, metadata: StreamMetadata, 
          videostream: Readable, audiostream: Readable) =>{
          if(this.platform.eufyClient.getStationDevice(station.getSerial(), channel).getSerial() === this.device.getSerial()){
            const stationStream: StationStream = {station, channel, metadata, videostream, audiostream};
            resolve(stationStream);
          }
        });
      });

      this.log.info('Stream channel from station livestream ' + streamData.channel.toString());
      
      this.log.debug(
        'Snapshot requested: ' + request.width + ' x ' + request.height,
        this.cameraName,
        this.debug,
      );
      this.log.debug(
        'Sending snapshot: ' +
          (resolution.width > 0 ? resolution.width : 'native') +
          ' x ' +
          (resolution.height > 0 ? resolution.height : 'native'),
        this.cameraName,
        this.debug,
      );
  
      let videoFormat = 'h264';
      const options = [
        '-hls_init_time 0',
        '-hls_time 2',
        '-hls_segment_type mpegts',
        '-absf aac_adtstoasc',
        //"-start_number 1",
        '-sc_threshold 0',
        `-g ${streamData.metadata.videoFPS}`,
        '-fflags genpts+nobuffer+flush_packets',
        //"-flush_packets 1",
        '-hls_playlist_type event',
        //"-hls_flags split_by_time",
        '-frag_size 1048576',
        '-analyzeduration 2147483647',
        '-probesize 2147483647',
      ];
      switch (streamData.metadata.videoCodec) {
        case VideoCodec.H264:
          videoFormat = 'h264';
          break;
        case VideoCodec.H265:
          videoFormat = 'hevc';
          break;
      }

      let imageBuffer = Buffer.alloc(0);

      // get device info
      ffmpeg.setFfmpegPath(ffmpegPath);      

      const command = ffmpeg()
        .addOptions([
          '-ss 0',
          '-frames:v 1',
        ])
        .addOptions(options)
        .input(streamData.videostream)
        .inputFormat(videoFormat)
        .inputFps(streamData.metadata.videoFPS)
        // .videoCodec('copy')
        .outputFormat('image2')
        .outputOptions(['-movflags frag_keyframe+empty_moov'])
        .on('error', (err, stdout, stderr) => {
          this.log.error(`ffmpegPreviewImage(): An error occurred: ${err.message}`);
          this.log.error(`ffmpegPreviewImage(): ffmpeg output:\n${stdout}`);
          this.log.error(`ffmpegPreviewImage(): ffmpeg stderr:\n${stderr}`);
          this.platform.eufyClient.stopStationLivestream(this.device.getSerial());
          callback(err);
        })
        .on('end', (stdout, stderr) => {
          this.log.debug('ffmpegPreviewImage(): Preview image generated!');
          this.log.info('ffmpeg fluent end');
          this.platform.eufyClient.stopStationLivestream(this.device.getSerial());
        })
        .on('close', (image) => {
          this.log.info('ffmpeg fluent close');
          this.platform.eufyClient.stopStationLivestream(this.device.getSerial());
        })
        .withSize(resolution.width+'x'+resolution.height)
        .withNoAudio();

      const ffstream = command.pipe();
      ffstream.on('data', (data: Uint8Array) => {
        imageBuffer = Buffer.concat([imageBuffer, data]);
      });
      this.platform.eufyClient.stopStationLivestream(this.device.getSerial());
      callback(undefined, imageBuffer);

      // //   let ffmpegArgs = this.videoConfig.stillImageSource || this.videoConfig.source;
      // // const url = await this.device.startStream();
      // // let ffmpegArgs = `-i ${url}`;
      // let ffmpegArgs = `-i ${stream.videostream}`;
      // this.log.debug('Thumbnail URL: ', ffmpegArgs);
  
      // ffmpegArgs += // Still
      //       ' -frames:v 1' +
      //       (resolution.videoFilter
      //         ? ' -filter:v ' + resolution.videoFilter
      //         : '') +
      //       ' -f image2 -';
  
      // try {

      //   const ffmpeg = spawn(this.videoProcessor, ffmpegArgs.split(/\s+/), {
      //     env: process.env,
      //   });

      //   let imageBuffer = Buffer.alloc(0);
      //   this.log.debug(
      //     'Snapshot command: ' + this.videoProcessor + ' ' + ffmpegArgs,
      //     this.cameraName,
      //     this.debug,
      //   );
      //   ffmpeg.stdout.on('data', (data: Uint8Array) => {
      //     imageBuffer = Buffer.concat([imageBuffer, data]);
      //   });
      //   const log = this.log;
      //   ffmpeg.on('error', (error: string) => {
      //     log.error(
      //       'An error occurred while making snapshot request: ' + error,
      //       this.cameraName,
      //     );
      //   });
      //   ffmpeg.on('close', () => {
      //     this.platform.eufyClient.stopStationLivestream(this.device.getSerial());
      //     callback(undefined, imageBuffer);
      //   });
      // } catch (err) {
      //   this.log.error(err, this.cameraName);
      //   // await this.device.stopStream();
      //   this.platform.eufyClient.stopStationLivestream(this.device.getSerial());
      //   callback(err);
      // }      
    }

    async getIpAddress(ipv6: boolean, interfaceName?: string): Promise<string> {
      if (!interfaceName) {
        interfaceName = await networkInterfaceDefault();
      }
      const interfaces = os.networkInterfaces();
      const externalInfo = interfaces[interfaceName]?.filter((info) => {
        return !info.internal;
      });
      const preferredFamily = ipv6 ? 'IPv6' : 'IPv4';
      const addressInfo =
        externalInfo?.find((info) => {
          return info.family === preferredFamily;
        }) || externalInfo?.[0];
      if (!addressInfo) {
        throw new Error(
          'Unable to get network address for "' + interfaceName + '"!',
        );
      }
      return addressInfo.address;
    }
  
    async prepareStream(
      request: PrepareStreamRequest,
      callback: PrepareStreamCallback,
    ): Promise<void> {
      const videoReturnPort = await getPort();
      const videoSSRC = this.hap.CameraController.generateSynchronisationSource();
      const audioReturnPort = await getPort();
      const audioSSRC = this.hap.CameraController.generateSynchronisationSource();
  
      const ipv6 = request.addressVersion === 'ipv6';


  
      let currentAddress: string;
      try {
        currentAddress = await this.getIpAddress(ipv6, this.interfaceName);
      } catch (ex) {
        if (this.interfaceName) {
          this.log.warn(ex + ' Falling back to default.', this.cameraName);
          currentAddress = await this.getIpAddress(ipv6);
        } else {
          throw ex;
        }
      }
  
      const sessionInfo: SessionInfo = {
        address: request.targetAddress,
        localAddress: currentAddress,
        ipv6: ipv6,
  
        videoPort: request.video.port,
        videoReturnPort: videoReturnPort,
        videoCryptoSuite: request.video.srtpCryptoSuite,
        videoSRTP: Buffer.concat([
          request.video.srtp_key,
          request.video.srtp_salt,
        ]),
        videoSSRC: videoSSRC,
  
        audioPort: request.audio.port,
        audioReturnPort: audioReturnPort,
        audioCryptoSuite: request.audio.srtpCryptoSuite,
        audioSRTP: Buffer.concat([
          request.audio.srtp_key,
          request.audio.srtp_salt,
        ]),
        audioSSRC: audioSSRC,
      };
  
      const response: PrepareStreamResponse = {
        address: currentAddress,
        video: {
          port: videoReturnPort,
          ssrc: videoSSRC,
  
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
        audio: {
          port: audioReturnPort,
          ssrc: audioSSRC,
  
          srtp_key: request.audio.srtp_key,
          srtp_salt: request.audio.srtp_salt,
        },
      };
  
      this.pendingSessions[request.sessionID] = sessionInfo;
      callback(undefined, response);
    }
  
    private async startStream(
      request: StartStreamRequest,
      callback: StreamRequestCallback,
    ): Promise<void> {
      const url = await this.device.startStream();
      this.log.debug('Doorbell stream URL: ', url);

      const sessionInfo = this.pendingSessions[request.sessionID];
      const vcodec = 'libx264';
      const mtu = 1316; // request.video.mtu is not used
      const encoderOptions = '-preset ultrafast';
  
      const resolution = this.determineResolution(request.video, false);
  
      const fps = request.video.fps;
      const videoBitrate = request.video.max_bit_rate;
      //   let fps = (this.videoConfig.forceMax && this.videoConfig.maxFPS) ||
      //     (request.video.fps > this.videoConfig.maxFPS) ?
      //     this.videoConfig.maxFPS : request.video.fps;
  
      //   let videoBitrate = (this.videoConfig.forceMax && this.videoConfig.maxBitrate) ||
      //     (request.video.max_bit_rate > this.videoConfig.maxBitrate) ?
      //     this.videoConfig.maxBitrate : request.video.max_bit_rate;
  
      //   if (vcodec === 'copy') {
      //     resolution.width = 0;
      //     resolution.height = 0;
      //     resolution.videoFilter = '';
      //     fps = 0;
      //     videoBitrate = 0;
      //   }
  
      this.log.debug(
        'Video stream requested: ' +
              request.video.width +
              ' x ' +
              request.video.height +
              ', ' +
              request.video.fps +
              ' fps, ' +
              request.video.max_bit_rate +
              ' kbps',
        this.cameraName,
        this.debug,
      );
      this.log.info(
        'Starting video stream: ' +
              (resolution.width > 0 ? resolution.width : 'native') +
              ' x ' +
              (resolution.height > 0 ? resolution.height : 'native') +
              ', ' +
              (fps > 0 ? fps : 'native') +
              ' fps, ' +
              (videoBitrate > 0 ? videoBitrate : '???') +
              ' kbps',
        this.cameraName,
      );
  
      //   let ffmpegArgs = this.videoConfig.source;
      let ffmpegArgs = `-i ${url}`;
  
      ffmpegArgs += // Video
            // (this.videoConfig.mapvideo ? ' -map ' + this.videoConfig.mapvideo : ' -an -sn -dn') +
            ' -an -sn -dn' +
            ' -codec:v ' +
            vcodec +
            ' -pix_fmt yuv420p' +
            ' -color_range mpeg' +
            // (fps > 0 ? ' -r ' + fps : '') +
            ' -f rawvideo' +
            (encoderOptions ? ' ' + encoderOptions : '') +
            (resolution.videoFilter.length > 0
              ? ' -filter:v ' + resolution.videoFilter
              : '') +
            (videoBitrate > 0 ? ' -b:v ' + videoBitrate + 'k' : '') +
            ' -payload_type ' +
            request.video.pt;
  
      ffmpegArgs += // Video Stream
            ' -ssrc ' +
            sessionInfo.videoSSRC +
            ' -f rtp' +
            ' -srtp_out_suite AES_CM_128_HMAC_SHA1_80' +
            ' -srtp_out_params ' +
            sessionInfo.videoSRTP.toString('base64') +
            ' srtp://' +
            sessionInfo.address +
            ':' +
            sessionInfo.videoPort +
            '?rtcpport=' +
            sessionInfo.videoPort +
            '&pkt_size=' +
            mtu;
  
      if (this.audio) {
        ffmpegArgs += // Audio
              //   (this.videoConfig.mapaudio ? ' -map ' + this.videoConfig.mapaudio : ' -vn -sn -dn') +
              ' -vn -sn -dn';
        ' -codec:a libfdk_aac' +
              ' -profile:a aac_eld' +
              ' -flags +global_header' +
              ' -f null' +
              ' -ar ' +
              request.audio.sample_rate +
              'k' +
              ' -b:a ' +
              request.audio.max_bit_rate +
              'k' +
              ' -ac ' +
              request.audio.channel +
              ' -payload_type ' +
              request.audio.pt;
  
        ffmpegArgs += // Audio Stream
              ' -ssrc ' +
              sessionInfo.audioSSRC +
              ' -f rtp' +
              ' -srtp_out_suite AES_CM_128_HMAC_SHA1_80' +
              ' -srtp_out_params ' +
              sessionInfo.audioSRTP.toString('base64') +
              ' srtp://' +
              sessionInfo.address +
              ':' +
              sessionInfo.audioPort +
              '?rtcpport=' +
              sessionInfo.audioPort +
              '&pkt_size=188';
      }
  
      if (this.debug) {
        ffmpegArgs += ' -loglevel level+verbose';
      }
  
      const activeSession: ActiveSession = {};
  
      activeSession.socket = createSocket(sessionInfo.ipv6 ? 'udp6' : 'udp4');
      activeSession.socket.on('error', (err: Error) => {
        this.log.error('Socket error: ' + err.name, this.cameraName);
        this.stopStream(request.sessionID);
      });
      activeSession.socket.on('message', () => {
        if (activeSession.timeout) {
          clearTimeout(activeSession.timeout);
        }
        activeSession.timeout = setTimeout(() => {
          this.log.info(
            'Device appears to be inactive. Stopping stream.',
            this.cameraName,
          );
          this.controller.forceStopStreamingSession(request.sessionID);
          this.stopStream(request.sessionID);
        }, request.video.rtcp_interval * 2 * 1000);
      });
      activeSession.socket.bind(
        sessionInfo.videoReturnPort,
        sessionInfo.localAddress,
      );
  
      activeSession.mainProcess = new FfmpegProcess(
        this.cameraName,
        request.sessionID,
        this.videoProcessor,
        ffmpegArgs,
        this.log,
        this.debug,
        this,
        callback,
      );
  
      //   if (this.videoConfig.returnAudioTarget) {
      //     let ffmpegReturnArgs =
      //       '-hide_banner' +
      //       ' -protocol_whitelist pipe,udp,rtp,file,crypto' +
      //       ' -f sdp' +
      //       ' -c:a libfdk_aac' +
      //       ' -i pipe:' +
      //       ' ' + this.videoConfig.returnAudioTarget;
  
      //     if (this.videoConfig.debugReturn) {
      //       ffmpegReturnArgs += ' -loglevel level+verbose';
      //     }
  
      //     const ipVer = sessionInfo.ipv6 ? 'IP6' : 'IP4';
  
      //     const sdpReturnAudio =
      //       'v=0\r\n' +
      //       'o=- 0 0 IN ' + ipVer + ' ' + sessionInfo.address + '\r\n' +
      //       's=Talk\r\n' +
      //       'c=IN ' + ipVer + ' ' + sessionInfo.address + '\r\n' +
      //       't=0 0\r\n' +
      //       'm=audio ' + sessionInfo.audioReturnPort + ' RTP/AVP 110\r\n' +
      //       'b=AS:24\r\n' +
      //       'a=rtpmap:110 MPEG4-GENERIC/16000/1\r\n' +
      //       'a=rtcp-mux\r\n' + // FFmpeg ignores this, but might as well
      //       'a=fmtp:110 ' +
      //         'profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; ' +
      //         'config=F8F0212C00BC00\r\n' +
      //       'a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:' + sessionInfo.audioSRTP.toString('base64') + '\r\n';
      //     activeSession.returnProcess = new FfmpegProcess(this.cameraName + '] [Two-way', request.sessionID,
      //       this.videoProcessor, ffmpegReturnArgs, this.log, this.videoConfig.debugReturn, this);
      //     activeSession.returnProcess.getStdin()?.end(sdpReturnAudio);
      //   }
  
      this.ongoingSessions[request.sessionID] = activeSession;
      delete this.pendingSessions[request.sessionID];

    }
  
    handleStreamRequest(
      request: StreamingRequest,
      callback: StreamRequestCallback,
    ): void {
      switch (request.type) {
        case StreamRequestTypes.START:
          this.startStream(request, callback);
          break;
        case StreamRequestTypes.RECONFIGURE:
          this.log.debug(
            'Received request to reconfigure: ' +
              request.video.width +
              ' x ' +
              request.video.height +
              ', ' +
              request.video.fps +
              ' fps, ' +
              request.video.max_bit_rate +
              ' kbps (Ignored)',
            this.cameraName,
            this.debug,
          );
          callback();
          break;
        case StreamRequestTypes.STOP:
          this.stopStream(request.sessionID);
          callback();
          break;
      }
    }
  
    public stopStream(sessionId: string): void {
      const session = this.ongoingSessions[sessionId];
      if (session) {
        if (session.timeout) {
          clearTimeout(session.timeout);
        }
        try {
          session.socket?.close();
        } catch (err) {
          this.log.error(
            'Error occurred closing socket: ' + err,
            this.cameraName,
          );
        }
        try {
          session.mainProcess?.stop();
        } catch (err) {
          this.log.error(
            'Error occurred terminating main FFmpeg process: ' + err,
            this.cameraName,
          );
        }
        try {
          session.returnProcess?.stop();
        } catch (err) {
          this.log.error(
            'Error occurred terminating two-way FFmpeg process: ' + err,
            this.cameraName,
          );
        }
      }
      delete this.ongoingSessions[sessionId];
      this.log.info('Stopped video stream.', this.cameraName);
  
      this.device.stopStream();
    }
}