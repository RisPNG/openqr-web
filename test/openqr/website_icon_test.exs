defmodule OpenQR.WebsiteIconTest do
  use ExUnit.Case, async: true

  alias OpenQR.WebsiteIcon

  test "detects a website without changing its destination text" do
    payload = "example.com/path?query=value#keep"
    assert %URI{} = website = WebsiteIcon.detect_website(payload)
    assert website.scheme == "https"
    assert website.host == "example.com"
    assert website.path == "/path"
    assert website.query == "query=value"
    assert website.fragment == "keep"
    assert WebsiteIcon.detect_website("http://example.com:8080/path").port == 8080
    assert WebsiteIcon.detect_website("https://93.184.215.14/").host == "93.184.215.14"
    assert WebsiteIcon.detect_website("b\u00FCcher.de/path#keep").host == "xn--bcher-kva.de"
    assert WebsiteIcon.detect_website("https://B\u00DCCHER.de/path#keep").fragment == "keep"
  end

  test "leaves ordinary text and malformed website inputs without a lookup" do
    for payload <- [
          "hello world",
          "person@example.com",
          "example",
          "93.184.215.14",
          "https://user:password@example.com",
          "ftp://example.com",
          "example.com/%zz",
          "https://example.com:0",
          "https://example.com:65536",
          "example.com\n",
          "https://127.1",
          "https://2130706433",
          "https://example.com\\@127.0.0.1",
          "bad_\u00FC.com",
          "b\u00FCcher.de:invalid/path",
          "https://b\u00FCcher.de:65536/path",
          "https://someone@b\u00FCcher.de/path",
          "b\u00FCcher.de/path?keys[]=value"
        ] do
      assert WebsiteIcon.detect_website(payload) == nil
      assert WebsiteIcon.fetch(payload) == :not_a_website
    end
  end

  test "rejects private and special IP destinations before opening a connection" do
    for host <- [
          "0.0.0.0",
          "10.0.0.1",
          "100.64.0.1",
          "127.0.0.1",
          "169.254.169.254",
          "172.16.0.1",
          "192.168.1.1",
          "198.18.0.1",
          "224.0.0.1",
          "255.255.255.255",
          "[::1]",
          "[::ffff:127.0.0.1]",
          "[fc00::1]",
          "[fe80::1]",
          "[2002:7f00:1::]",
          "[2001:db8::1]"
        ] do
      assert {:error, message} = WebsiteIcon.fetch("http://#{host}/private?secret=value")
      assert message =~ "Upload a reference image"
      assert message =~ "disable website icon lookup"
    end
  end

  test "discovers large raster icons relative to the homepage base with favicon fallback" do
    homepage = URI.new!("https://example.com/")

    html = """
    <base href="/assets/">
    <link rel="stylesheet" href="application.css">
    <link rel="icon" sizes="16x16" href="small.png">
    <link rel="shortcut icon" sizes="64x64" href="large.png?revision=2">
    <link rel="apple-touch-icon" sizes="180x180" href="//cdn.example.com/apple.png">
    <link rel="icon" sizes="any" type="image/svg+xml" href="vector">
    <link rel="icon" sizes="512x512" href="vector.svg?revision=3">
    <link rel="icon" href="data:image/png;base64,AA==">
    """

    assert Enum.map(WebsiteIcon.discover_icons(html, homepage), &URI.to_string/1) == [
             "https://cdn.example.com/apple.png",
             "https://example.com/assets/large.png?revision=2",
             "https://example.com/assets/small.png",
             "https://example.com/favicon.ico"
           ]
  end

  test "chooses the declared backdrop variant and caps metadata requests" do
    homepage = URI.new!("https://example.com/")

    html = """
    <link rel="icon" href="/light.png" media="(prefers-color-scheme: light)">
    <link rel="icon" href="/dark.png" media="(prefers-color-scheme: dark)">
    <link rel="icon" href="/one.png" sizes="1x1">
    <link rel="icon" href="/two.png" sizes="2x2">
    <link rel="icon" href="/three.png" sizes="3x3">
    <link rel="icon" href="/four.png" sizes="4x4">
    <link rel="icon" href="/five.png" sizes="5x5">
    """

    dark = Enum.map(WebsiteIcon.discover_icons(html, homepage, dark: true), &URI.to_string/1)
    light = Enum.map(WebsiteIcon.discover_icons(html, homepage), &URI.to_string/1)
    assert hd(dark) == "https://example.com/dark.png"
    refute "https://example.com/light.png" in dark
    assert hd(light) == "https://example.com/light.png"
    refute "https://example.com/dark.png" in light
    assert length(dark) == 5
    assert List.last(dark) == "https://example.com/favicon.ico"

    assert WebsiteIcon.discover_icons("", homepage) == [
             URI.new!("https://example.com/favicon.ico")
           ]
  end
end
