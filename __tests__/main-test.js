import 'react-native';
import WebRTCPeer from '../WebRTCPeer';

describe('WebRTCPeer instantiation', () => {
  it('Instantiate with default params', () => {
    const myPeer = new WebRTCPeer('rcvonly');
    expect(2).toEqual(2);
  });
});
