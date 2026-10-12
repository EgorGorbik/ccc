import Script from 'next/script';
export default function CaptureLayout({children}:{children:React.ReactNode}){
 return <>
  <Script id="falcon-share" strategy="beforeInteractive">{`try{window.__falconShare=navigator.mediaDevices.getDisplayMedia({video:true,audio:false});}catch(e){window.__falconShare=Promise.reject(e);}`}</Script>
  {children}
 </>;
}
